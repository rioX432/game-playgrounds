//! Pure, render-agnostic snapshot interpolation buffer.
//!
//! This is the client half of the chapter's server-authoritative +
//! client-interpolation pattern, the Rust mirror of
//! `net/web-three/src/net/snapshotBuffer.ts`. The CRITICAL design rule (Codex):
//! we do NOT replicate the render `Transform` and then smooth it. Replicon
//! mutates the small replicated sim component [`crate::protocol::NetPosition`];
//! a client system appends each mutation here as a timestamped sample, and the
//! render layer writes `Transform` from the value this buffer interpolates at
//! `render_time = now - interp_delay`. The buffer owns NO Bevy-render or renet
//! types, so it is fully `cargo test`-able with no window and no socket.
//!
//! One [`InterpBuffer`] holds the recent samples for ONE entity. Boolean state
//! (`flags`) is NOT interpolated — the newer sample's value is taken (mirrors the
//! web buffer, where flags come from the newer authoritative frame).

use bevy::math::Vec3;

/// One timestamped authoritative sample for a single entity.
#[derive(Clone, Copy, Debug)]
struct Sample {
    /// Local client time (seconds) when this authoritative value was observed.
    time: f64,
    pos: Vec3,
    flags: u8,
}

/// The interpolated render value produced by [`InterpBuffer::sample_at`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InterpResult {
    pub pos: Vec3,
    /// Taken verbatim from the newer bracketing sample (not interpolated).
    pub flags: u8,
}

/// Per-entity ring of recent authoritative samples, sorted ascending by `time`.
/// Out-of-order / duplicate samples (`time <= newest`) are dropped so
/// interpolation only ever advances forward (mirrors `SnapshotBuffer.push`).
#[derive(Debug)]
pub struct InterpBuffer {
    samples: Vec<Sample>,
    max: usize,
}

impl InterpBuffer {
    /// Create a buffer retaining at most `max` samples (clamped to >= 1).
    pub fn new(max: usize) -> Self {
        Self {
            samples: Vec::new(),
            max: max.max(1),
        }
    }

    /// Ingest an authoritative value observed at local `time`. No-op for an
    /// out-of-order or duplicate sample.
    pub fn push(&mut self, time: f64, pos: Vec3, flags: u8) {
        if let Some(newest) = self.samples.last() {
            if time <= newest.time {
                return;
            }
        }
        self.samples.push(Sample { time, pos, flags });
        while self.samples.len() > self.max {
            self.samples.remove(0);
        }
    }

    /// Number of buffered samples.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    /// Whether the buffer holds no samples.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Local time of the freshest sample, or `None` when empty.
    pub fn latest_time(&self) -> Option<f64> {
        self.samples.last().map(|s| s.time)
    }

    /// Interpolated value at `time`:
    /// - empty buffer → `None`
    /// - before the oldest sample → clamp to the oldest (no back-extrapolation)
    /// - after the newest sample → hold the newest (no forward-extrapolation)
    /// - otherwise → linear blend of the two bracketing samples.
    pub fn sample_at(&self, time: f64) -> Option<InterpResult> {
        let n = self.samples.len();
        if n == 0 {
            return None;
        }
        let first = &self.samples[0];
        let last = &self.samples[n - 1];
        if time <= first.time {
            return Some(InterpResult {
                pos: first.pos,
                flags: first.flags,
            });
        }
        if time >= last.time {
            return Some(InterpResult {
                pos: last.pos,
                flags: last.flags,
            });
        }
        for i in 0..n - 1 {
            let a = &self.samples[i];
            let b = &self.samples[i + 1];
            if time >= a.time && time < b.time {
                let span = b.time - a.time;
                let alpha = if span > 0.0 {
                    ((time - a.time) / span) as f32
                } else {
                    0.0
                };
                return Some(InterpResult {
                    pos: a.pos.lerp(b.pos, alpha),
                    // Boolean state is not interpolated — newer frame wins.
                    flags: b.flags,
                });
            }
        }
        // Unreachable given the clamp guards; hold newest defensively.
        Some(InterpResult {
            pos: last.pos,
            flags: last.flags,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_buffer_samples_none() {
        let b = InterpBuffer::new(8);
        assert!(b.is_empty());
        assert_eq!(b.sample_at(1.0), None);
    }

    #[test]
    fn out_of_order_samples_dropped() {
        let mut b = InterpBuffer::new(8);
        b.push(1.0, Vec3::X, 0);
        b.push(1.0, Vec3::Y, 0); // duplicate time
        b.push(0.5, Vec3::Z, 0); // older
        assert_eq!(b.len(), 1);
        assert_eq!(b.latest_time(), Some(1.0));
    }

    #[test]
    fn clamps_before_oldest_and_after_newest() {
        let mut b = InterpBuffer::new(8);
        b.push(1.0, Vec3::new(0.0, 0.0, 0.0), 1);
        b.push(2.0, Vec3::new(10.0, 0.0, 0.0), 3);
        // Before oldest → oldest.
        assert_eq!(b.sample_at(0.0).unwrap().pos, Vec3::new(0.0, 0.0, 0.0));
        // After newest → newest (and its flags).
        let after = b.sample_at(5.0).unwrap();
        assert_eq!(after.pos, Vec3::new(10.0, 0.0, 0.0));
        assert_eq!(after.flags, 3);
    }

    #[test]
    fn interpolates_midpoint_and_takes_newer_flags() {
        let mut b = InterpBuffer::new(8);
        b.push(1.0, Vec3::new(0.0, 0.0, 0.0), 0b01);
        b.push(2.0, Vec3::new(4.0, 0.0, 8.0), 0b11);
        let mid = b.sample_at(1.5).unwrap();
        assert!((mid.pos.x - 2.0).abs() < 1e-5, "x halfway");
        assert!((mid.pos.z - 4.0).abs() < 1e-5, "z halfway");
        // Flags are NOT interpolated; the newer sample's bits are taken.
        assert_eq!(mid.flags, 0b11);
    }

    #[test]
    fn retains_at_most_max_samples() {
        let mut b = InterpBuffer::new(3);
        for i in 0..10 {
            b.push(i as f64, Vec3::splat(i as f32), 0);
        }
        assert_eq!(b.len(), 3);
        // Oldest retained is sample 7; sampling before it clamps to it.
        assert_eq!(b.sample_at(0.0).unwrap().pos, Vec3::splat(7.0));
    }
}
