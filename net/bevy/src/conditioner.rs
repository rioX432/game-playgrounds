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
//! DOCUMENTED GAP: because injection is above netcode, renet's transport RTT does
//! NOT reflect injected delay — so `rttP50/P95Ms` stay near the loopback floor
//! under a latency sweep; the delay's effect surfaces in `snapshotAge` (down) and
//! input-application lag (up) instead. The web app-echo RTT, by contrast, passes
//! through its shim. This difference is itself a §8 finding.

use std::collections::VecDeque;

use crate::rng::Rng;

/// One direction's impairment knobs (mirrors the web `LinkConfig`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinkConfig {
    /// One-way delay added before delivery, ms.
    pub delay_ms: f64,
    /// Drop probability, percent in `[0, 100]`.
    pub loss_pct: f64,
}

impl LinkConfig {
    /// A clean link: no delay, no loss (the default / passthrough).
    pub const CLEAN: LinkConfig = LinkConfig {
        delay_ms: 0.0,
        loss_pct: 0.0,
    };

    pub fn new(delay_ms: f64, loss_pct: f64) -> Self {
        Self { delay_ms, loss_pct }
    }
}

/// What `offer` decided for one item.
#[derive(Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Accepted into the link (delivered immediately if delay 0, else deferred).
    Accepted,
    /// Dropped in transit (loss) — never delivered.
    Dropped,
}

/// Applies per-direction delay + loss to delivery of payloads of type `T`.
///
/// Model: `offer` either drops an item (loss) or enqueues it with a release time
/// (`now + delay`); `drain_due` releases every item whose time has passed, FIFO.
/// With delay 0 an item enqueued at `now` is released by `drain_due(now)` the SAME
/// update — the deterministic synchronous fast path the web shim has. Constant
/// per-direction delay keeps release times non-decreasing, so front-popping is
/// correct FIFO; the world's stale-`seq` guard absorbs any residual reorder.
pub struct Conditioner<T> {
    config: LinkConfig,
    rng: Rng,
    pending: VecDeque<(f64, T)>,
}

impl<T> Conditioner<T> {
    /// Build a conditioner. `rng` is a dedicated seeded stream (NOT shared with
    /// bot motion) so loss draws never perturb bot trajectory reproducibility.
    pub fn new(config: LinkConfig, rng: Rng) -> Self {
        Self {
            config,
            rng,
            pending: VecDeque::new(),
        }
    }

    /// True if this conditioner injects nothing.
    pub fn is_passthrough(&self) -> bool {
        self.config.delay_ms <= 0.0 && self.config.loss_pct <= 0.0
    }

    /// Offer one item to the link at monotonic time `now_secs`. Returns whether it
    /// was accepted (then retrieve it from [`drain_due`]) or dropped by loss.
    pub fn offer(&mut self, now_secs: f64, item: T) -> Disposition {
        if self.config.loss_pct > 0.0 && self.rng.next_f64() * 100.0 < self.config.loss_pct {
            return Disposition::Dropped;
        }
        let release = now_secs + (self.config.delay_ms / 1000.0).max(0.0);
        self.pending.push_back((release, item));
        Disposition::Accepted
    }

    /// Pop every pending item whose release time is `<= now_secs`, in FIFO order.
    pub fn drain_due(&mut self, now_secs: f64) -> Vec<T> {
        let mut out = Vec::new();
        while let Some((release, _)) = self.pending.front() {
            if *release <= now_secs {
                out.push(self.pending.pop_front().unwrap().1);
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

    #[test]
    fn clean_link_delivers_same_update_and_never_drops() {
        let mut c: Conditioner<u32> = Conditioner::new(LinkConfig::CLEAN, Rng::new(1));
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
        let mut c: Conditioner<u32> = Conditioner::new(LinkConfig::new(50.0, 0.0), Rng::new(1));
        assert_eq!(c.offer(1.000, 7), Disposition::Accepted);
        assert!(c.drain_due(1.049).is_empty()); // not yet due
        assert_eq!(c.drain_due(1.050), vec![7]); // due at +50 ms
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn delayed_items_release_in_fifo_order() {
        let mut c: Conditioner<u32> = Conditioner::new(LinkConfig::new(20.0, 0.0), Rng::new(1));
        c.offer(0.000, 1); // release .020
        c.offer(0.005, 2); // release .025
        c.offer(0.010, 3); // release .030
        assert_eq!(c.drain_due(0.030), vec![1, 2, 3]);
    }

    #[test]
    fn loss_drops_approximately_the_configured_fraction() {
        let mut c: Conditioner<u32> = Conditioner::new(LinkConfig::new(0.0, 50.0), Rng::new(12345));
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
            let mut c: Conditioner<u32> =
                Conditioner::new(LinkConfig::new(0.0, 30.0), Rng::new(seed));
            (0..50)
                .map(|i| c.offer(0.0, i) == Disposition::Dropped)
                .collect::<Vec<_>>()
        };
        assert_eq!(draws(99), draws(99));
    }
}
