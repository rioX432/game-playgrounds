//! App-level transport conditioner — the Bevy mirror of the web `TransportShim`.
//!
//! WHY APP-LEVEL (an honest-parity finding for #147 / COMPARISON §8, verified
//! against crate source, NOT assumed):
//! - **renet 2.0 ships no network conditioner.** It only *reports* `packet_loss`
//!   / `rtt`; there is no latency/jitter/loss INJECTION knob (checked
//!   `renet-2.0.0/src`, `renetcode-2.0.0/src`).
//! - **`renet_netcode` 2.0 takes a concrete `std::net::UdpSocket`**, not a trait,
//!   so a custom conditioning socket cannot be slotted under the transport; and a
//!   UDP relay proxy would fight netcode's address validation.
//!
//! So, exactly like the web side (whose shim is also app-level over Colyseus's
//! reliable channel), impairment is injected in application code:
//! - **Uplink (client→server)** conditions the SERVER folding a received
//!   `InputMessage` into authoritative state — mirrors `shim.up` wrapping
//!   `world.applyInput`.
//! - **Downlink (server→client)** conditions the PROBE CLIENT folding a replicated
//!   mutation into its interpolation buffer — mirrors the EFFECT of `shim.down`
//!   (the client renders a late/missing snapshot). It is on the receive side
//!   because replicon OWNS the send side; the observable effect (staler
//!   `snapshotAge`, dropped frames) is the same.
//!
//! JITTER (#159): each direction adds a per-delivery offset from the SHARED
//! `JitterSampler` (`crate::jitter`, a bit-for-bit port of `net-protocol`'s), so a
//! seed reproduces the same jitter stream as the web shim. Because effective delays
//! now VARY, release times are no longer monotonic — so the pending queue is a
//! release-time PRIORITY QUEUE (a `BinaryHeap`), NOT a FIFO `VecDeque`: a later-offered
//! item with a smaller jitter can be released BEFORE an earlier one (emergent
//! reorder). Unlike the web (reliable ordered channel → reorder is only an
//! APPROXIMATION), renet runs over UDP, so out-of-order delivery here is FAITHFUL.
//!
//! DOCUMENTED GAP: because injection is above netcode, renet's transport RTT does
//! NOT reflect injected delay — so `rttP50/P95Ms` stay near the loopback floor
//! under a latency sweep; the delay's effect surfaces in `snapshotAge` (down) and
//! input-application lag (up) instead. The web app-echo RTT, by contrast, passes
//! through its shim. This difference is itself a §8 finding.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::jitter::{JitterConfig, JitterSampler};
use crate::rng::Rng;

/// One direction's impairment knobs (mirrors the web `LinkConfig`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinkConfig {
    /// One-way base delay added before delivery, ms.
    pub delay_ms: f64,
    /// Drop probability, percent in `[0, 100]`.
    pub loss_pct: f64,
    /// Per-delivery delay jitter (added to `delay_ms`). Default = no jitter.
    pub jitter: JitterConfig,
}

impl LinkConfig {
    /// A clean link: no delay, no jitter, no loss (the default / passthrough).
    pub const CLEAN: LinkConfig = LinkConfig {
        delay_ms: 0.0,
        loss_pct: 0.0,
        jitter: JitterConfig::NONE,
    };

    /// Delay + loss, no jitter (the pre-#159 constructor — kept for existing call sites).
    pub fn new(delay_ms: f64, loss_pct: f64) -> Self {
        Self {
            delay_ms,
            loss_pct,
            jitter: JitterConfig::NONE,
        }
    }

    /// Delay + loss + jitter.
    pub fn with_jitter(delay_ms: f64, loss_pct: f64, jitter: JitterConfig) -> Self {
        Self {
            delay_ms,
            loss_pct,
            jitter,
        }
    }
}

/// What `offer` decided for one item.
#[derive(Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Accepted into the link (delivered immediately if effective delay 0, else deferred).
    Accepted,
    /// Dropped in transit (loss) — never delivered.
    Dropped,
}

/// A pending item keyed by release time (then offer order for ties). Ordered so a
/// `BinaryHeap` releases the EARLIEST first; the offer-order `seq` breaks ties so
/// equal-release items stay FIFO (matches the no-jitter case exactly).
struct Pending<T> {
    release: f64,
    seq: u64,
    item: T,
}

impl<T> PartialEq for Pending<T> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl<T> Eq for Pending<T> {}
impl<T> Ord for Pending<T> {
    fn cmp(&self, other: &Self) -> Ordering {
        // EARLIEST release is "greatest" so `BinaryHeap` (a max-heap) pops it first;
        // i.e. invert the natural order. `total_cmp` keeps it total over f64.
        other
            .release
            .total_cmp(&self.release)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}
impl<T> PartialOrd for Pending<T> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Applies per-direction delay + jitter + loss to delivery of payloads of type `T`.
///
/// Model: `offer` either drops an item (loss) or enqueues it with a release time
/// (`now + max(0, delay + jitter)`); `drain_due` releases every item whose time has
/// passed, EARLIEST-FIRST. With delay 0 and no jitter an item enqueued at `now` is
/// released by `drain_due(now)` the SAME update — the deterministic synchronous fast
/// path the web shim has. With jitter, release times vary, so the priority queue can
/// release a later-offered item first (emergent reorder); the world's stale-`seq`
/// guard absorbs it.
pub struct Conditioner<T> {
    config: LinkConfig,
    loss_rng: Rng,
    jitter: JitterSampler,
    pending: BinaryHeap<Pending<T>>,
    seq: u64,
}

impl<T> Conditioner<T> {
    /// Build a conditioner.
    ///
    /// `loss_rng` and `jitter_rng` are DISTINCT dedicated seeded streams (NOT shared
    /// with bot motion, nor with each other) so loss draws and jitter draws never
    /// perturb one another's reproducibility. A no-jitter config never touches
    /// `jitter_rng` (the sampler is a no-op), so it's harmless to pass one anyway.
    pub fn new(config: LinkConfig, loss_rng: Rng, jitter_rng: Rng) -> Self {
        Self {
            config,
            loss_rng,
            jitter: JitterSampler::new(config.jitter, jitter_rng),
            pending: BinaryHeap::new(),
            seq: 0,
        }
    }

    /// True if this conditioner injects nothing (delivers synchronously, never drops).
    pub fn is_passthrough(&self) -> bool {
        self.config.delay_ms <= 0.0 && self.config.loss_pct <= 0.0 && self.jitter.is_noop()
    }

    /// Offer one item to the link at monotonic time `now_secs`. Returns whether it
    /// was accepted (then retrieve it from [`drain_due`]) or dropped by loss.
    pub fn offer(&mut self, now_secs: f64, item: T) -> Disposition {
        if self.config.loss_pct > 0.0 && self.loss_rng.next_f64() * 100.0 < self.config.loss_pct {
            return Disposition::Dropped;
        }
        // Effective delay = base + jitter, floored at 0. A no-op sampler draws
        // nothing, so a no-jitter link keeps release times monotonic (pure FIFO).
        let eff_delay_ms = if self.jitter.is_noop() {
            self.config.delay_ms
        } else {
            (self.config.delay_ms + self.jitter.sample()).max(0.0)
        };
        let release = now_secs + (eff_delay_ms / 1000.0).max(0.0);
        self.pending.push(Pending {
            release,
            seq: self.seq,
            item,
        });
        self.seq += 1;
        Disposition::Accepted
    }

    /// Pop every pending item whose release time is `<= now_secs`, EARLIEST-FIRST
    /// (FIFO among equal release times).
    pub fn drain_due(&mut self, now_secs: f64) -> Vec<T> {
        let mut out = Vec::new();
        while let Some(top) = self.pending.peek() {
            if top.release <= now_secs {
                out.push(self.pending.pop().unwrap().item);
            } else {
                break;
            }
        }
        out
    }

    /// Number of items currently held for later release (tests / introspection).
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jitter::JitterDistribution;

    /// A jitter rng is required by the new signature; no-jitter tests pass any seed
    /// (the sampler is a no-op and never draws from it).
    fn no_jitter_cond<T>(config: LinkConfig, loss_seed: u32) -> Conditioner<T> {
        Conditioner::new(config, Rng::new(loss_seed), Rng::new(loss_seed ^ 0xabcd))
    }

    #[test]
    fn clean_link_delivers_same_update_and_never_drops() {
        let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::CLEAN, 1);
        assert!(c.is_passthrough());
        for i in 0..100 {
            assert_eq!(c.offer(2.0, i), Disposition::Accepted);
        }
        // delay 0 => everything offered at t=2.0 is due at t=2.0 (synchronous).
        let due = c.drain_due(2.0);
        assert_eq!(due.len(), 100);
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn delay_defers_until_release_time() {
        let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::new(50.0, 0.0), 1);
        assert_eq!(c.offer(1.000, 7), Disposition::Accepted);
        assert!(c.drain_due(1.049).is_empty()); // not yet due
        assert_eq!(c.drain_due(1.050), vec![7]); // due at +50 ms
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn delayed_items_release_in_fifo_order_without_jitter() {
        let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::new(20.0, 0.0), 1);
        c.offer(0.000, 1); // release .020
        c.offer(0.005, 2); // release .025
        c.offer(0.010, 3); // release .030
        assert_eq!(c.drain_due(0.030), vec![1, 2, 3]);
    }

    #[test]
    fn equal_release_times_stay_fifo_by_offer_order() {
        // All offered at the same instant with the same delay ⇒ identical release ⇒
        // the seq tiebreak must preserve offer order out of the priority queue.
        let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::new(10.0, 0.0), 1);
        for i in 0..50 {
            c.offer(1.0, i);
        }
        assert_eq!(c.drain_due(1.010), (0..50).collect::<Vec<_>>());
    }

    #[test]
    fn jitter_can_reorder_release_and_priority_queue_drains_earliest_first() {
        // Large jitter on a modest base delay so some items overtake earlier ones.
        // The OLD VecDeque front-pop-break would strand a later-but-earlier-release
        // item behind a still-pending front; the BinaryHeap releases by time.
        let cfg = LinkConfig::with_jitter(
            50.0,
            0.0,
            JitterConfig {
                sigma_ms: 25.0,
                distribution: JitterDistribution::Normal,
                correlation: 0.0,
            },
        );
        let mut c: Conditioner<u32> = Conditioner::new(cfg, Rng::new(1), Rng::new(2));
        for i in 0..30 {
            c.offer(0.0, i); // all offered at t=0; each gets 50ms ± jitter
        }
        // Drain far in the future: everything releases, EARLIEST-first.
        let order = c.drain_due(100.0);
        assert_eq!(order.len(), 30, "no loss ⇒ all delivered");
        // The delivery order is a permutation of 0..30 (reorder happened).
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..30).collect::<Vec<_>>());
        assert_ne!(order, (0..30).collect::<Vec<_>>(), "jitter must reorder");
    }

    #[test]
    fn jitter_is_reproducible_for_a_seed() {
        let cfg = LinkConfig::with_jitter(
            40.0,
            0.0,
            JitterConfig {
                sigma_ms: 15.0,
                distribution: JitterDistribution::ParetoNormal,
                correlation: 0.25,
            },
        );
        let run = || {
            let mut c: Conditioner<u32> = Conditioner::new(cfg, Rng::new(7), Rng::new(8));
            for i in 0..40 {
                c.offer(0.0, i);
            }
            c.drain_due(100.0)
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn loss_drops_approximately_the_configured_fraction() {
        let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::new(0.0, 50.0), 12345);
        let n = 10_000;
        let mut dropped = 0;
        for i in 0..n {
            if c.offer(0.0, i) == Disposition::Dropped {
                dropped += 1;
            }
        }
        let rate = dropped as f64 / n as f64;
        assert!((0.45..0.55).contains(&rate), "drop rate {rate} off target");
    }

    #[test]
    fn loss_draw_is_reproducible_for_a_seed() {
        let draws = |seed: u32| {
            let mut c: Conditioner<u32> = no_jitter_cond(LinkConfig::new(0.0, 30.0), seed);
            (0..50)
                .map(|i| c.offer(0.0, i) == Disposition::Dropped)
                .collect::<Vec<_>>()
        };
        assert_eq!(draws(99), draws(99));
    }
}
