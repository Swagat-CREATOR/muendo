// §36.6 U7: how the agent cursor gets from where it is to where the agent acts.
//
// A `MotionPlanner` turns one move into timed samples; the window (window.rs) plays them back by the clock. Two
// planners exist:
//
//   Glide       built in, always there: a straight, eased glide whose length in time follows Fitts's law.
//   CuaPlanner  Cua's own planner, the one cua-driver draws its cursor with (cua_motion.rs), behind the non-default
//               `cua-motion` feature, so the overlay can move exactly like the driver's cursor would have.
//
// Units: the overlay plans in physical pixels. Cua's planner thinks in points (its peak speed is 900 pt/s), so on a
// display scaled above 100% the same move covers more pixels and takes a little longer than Cua's driver would
// draw it. Seconds are seconds either way.

use crate::coords::Px;
use std::f64::consts::{FRAC_PI_4, PI};

/// The arrow's heading at rest, in Cua's convention: pi/4, the arrow pointing up and to the left.
pub const REST_HEADING: f64 = FRAC_PI_4;

/// Every trajectory is sampled at this rate.
pub const SAMPLES_PER_SECOND: f64 = 120.0;

/// One move to plan.
#[derive(Debug, Clone, PartialEq)]
pub struct MoveRequest {
    /// Where the cursor is now.
    pub from: Px,
    /// Its heading now, radians.
    pub from_heading: f64,
    /// Where the act is.
    pub to: Px,
    /// The heading to come to rest at.
    pub end_heading: f64,
    /// The element's rectangle `[x, y, w, h]` when it is known (it is not, yet: no UIA lookup, §36.6 U5.3).
    pub target: Option<[f64; 4]>,
    /// The same seed gives the same motion: "<cursor>|<move number>".
    pub seed: String,
    /// The user asked Windows for less animation: arrive at once, or nearly.
    pub reduced_motion: bool,
}

impl MoveRequest {
    /// A move between two points, at rest heading both ends.
    pub fn new(from: Px, to: Px) -> MoveRequest {
        MoveRequest {
            from,
            from_heading: REST_HEADING,
            to,
            end_heading: REST_HEADING,
            target: None,
            seed: String::new(),
            reduced_motion: false,
        }
    }
}

/// One point of a trajectory: seconds from the start, the hotspot, and the heading in radians.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub heading: f64,
}

/// Plans a move. A plan always has at least one sample, starts at `t = 0` and ends at the request's `to`.
pub trait MotionPlanner: Send {
    fn plan(&self, request: &MoveRequest) -> Vec<Sample>;
}

/// How long a plan lasts, in seconds.
pub fn duration(samples: &[Sample]) -> f64 {
    samples.last().map_or(0.0, |s| s.t)
}

/// The cursor at `t` seconds: interpolated between the two samples around it, held at either end. The heading turns
/// the short way round.
pub fn sample_at(samples: &[Sample], t: f64) -> Sample {
    let (Some(&first), Some(&last)) = (samples.first(), samples.last()) else {
        return Sample {
            t,
            x: 0.0,
            y: 0.0,
            heading: REST_HEADING,
        };
    };
    if t <= first.t {
        return first;
    }
    if t >= last.t {
        return last;
    }
    let after = samples.partition_point(|s| s.t <= t);
    let (a, b) = (samples[after - 1], samples[after]);
    let f = (t - a.t) / (b.t - a.t);
    Sample {
        t,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        heading: a.heading + wrap_angle(b.heading - a.heading) * f,
    }
}

/// An angle brought into (-pi, pi].
pub fn wrap_angle(a: f64) -> f64 {
    let a = a.rem_euclid(2.0 * PI);
    if a > PI { a - 2.0 * PI } else { a }
}

/// The planner the overlay uses: Cua's with the `cua-motion` feature, the built-in glide without it.
pub fn default_planner() -> Box<dyn MotionPlanner> {
    #[cfg(feature = "cua-motion")]
    {
        Box::new(crate::cua_motion::CuaPlanner::default())
    }
    #[cfg(not(feature = "cua-motion"))]
    {
        Box::new(Glide)
    }
}

/// The built-in planner: a straight line, eased in and out (smoothstep), taking `0.1 + 0.1 * log2(D / W + 1)`
/// seconds (Fitts's law, Shannon's form) for a distance `D` to a target `W` pixels across, held between 0.2 s and
/// 0.8 s. The heading turns evenly from its start to its rest value; the arrow does not lean into the move.
pub struct Glide;

/// The target width assumed when the element's rectangle is not known.
const DEFAULT_TARGET: f64 = 24.0;

impl MotionPlanner for Glide {
    fn plan(&self, r: &MoveRequest) -> Vec<Sample> {
        let (dx, dy) = (r.to.x - r.from.x, r.to.y - r.from.y);
        let distance = dx.hypot(dy);
        let arrive = Sample {
            t: 0.0,
            x: r.to.x,
            y: r.to.y,
            heading: r.end_heading,
        };
        if r.reduced_motion || !distance.is_finite() || distance < 0.5 {
            return vec![arrive];
        }
        let width = r
            .target
            .map(|t| t[2].min(t[3]))
            .filter(|w| w.is_finite() && *w > 0.0)
            .unwrap_or(DEFAULT_TARGET);
        let seconds = (0.1 + 0.1 * (distance / width + 1.0).log2()).clamp(0.2, 0.8);
        let n = (seconds * SAMPLES_PER_SECOND).ceil() as usize;
        let turn = wrap_angle(r.end_heading - r.from_heading);
        let mut samples: Vec<Sample> = (0..=n)
            .map(|i| {
                let u = i as f64 / n as f64;
                let f = u * u * (3.0 - 2.0 * u);
                Sample {
                    t: seconds * u,
                    x: r.from.x + dx * f,
                    y: r.from.y + dy * f,
                    heading: r.from_heading + turn * f,
                }
            })
            .collect();
        // Exactly the act's point at the end, whatever the rounding did.
        if let Some(last) = samples.last_mut() {
            *last = Sample {
                t: seconds,
                ..arrive
            };
        }
        samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glide(from: (f64, f64), to: (f64, f64)) -> Vec<Sample> {
        Glide.plan(&MoveRequest::new(
            Px::new(from.0, from.1),
            Px::new(to.0, to.1),
        ))
    }

    #[test]
    fn a_glide_starts_where_the_cursor_is_and_ends_exactly_at_the_act() {
        let s = glide((-1500.0, 300.0), (812.0, 411.0));
        let (first, last) = (s[0], *s.last().unwrap());
        assert_eq!((first.t, first.x, first.y), (0.0, -1500.0, 300.0));
        assert_eq!((last.x, last.y, last.heading), (812.0, 411.0, REST_HEADING));
        assert!(
            s.windows(2).all(|w| w[1].t > w[0].t),
            "time only goes forward"
        );
        // Never further from the act than the sample before: a straight glide, no overshoot.
        let left = |p: &Sample| (812.0 - p.x).hypot(411.0 - p.y);
        assert!(s.windows(2).all(|w| left(&w[1]) <= left(&w[0]) + 1e-9));
        // About 120 samples a second.
        let rate = (s.len() - 1) as f64 / duration(&s);
        assert!((rate - SAMPLES_PER_SECOND).abs() < 2.0, "{rate}");
    }

    #[test]
    fn a_longer_move_takes_longer_within_bounds() {
        let near = duration(&glide((0.0, 0.0), (30.0, 0.0)));
        let far = duration(&glide((0.0, 0.0), (2400.0, 900.0)));
        let farther = duration(&glide((0.0, 0.0), (40_000.0, 0.0)));
        assert!(near >= 0.2 && near < far, "{near} {far}");
        assert!(far <= 0.8 && farther == 0.8, "{far} {farther}");
        // A big known target is quicker to reach than the default small one.
        let mut big = MoveRequest::new(Px::new(0.0, 0.0), Px::new(2400.0, 900.0));
        big.target = Some([2300.0, 850.0, 300.0, 120.0]);
        assert!(duration(&Glide.plan(&big)) < far);
    }

    #[test]
    fn reduced_motion_and_no_distance_arrive_at_once() {
        let mut r = MoveRequest::new(Px::new(0.0, 0.0), Px::new(900.0, 40.0));
        r.reduced_motion = true;
        let s = Glide.plan(&r);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].t, s[0].x, s[0].y), (0.0, 900.0, 40.0));
        assert_eq!(glide((5.0, 5.0), (5.2, 5.0)).len(), 1);
        let nan = glide((f64::NAN, 0.0), (5.0, 5.0));
        assert_eq!((nan.len(), nan[0].x), (1, 5.0));
    }

    #[test]
    fn the_heading_turns_the_short_way() {
        let mut r = MoveRequest::new(Px::new(0.0, 0.0), Px::new(500.0, 0.0));
        r.from_heading = 3.0;
        r.end_heading = -3.0;
        let s = Glide.plan(&r);
        let mid = sample_at(&s, duration(&s) / 2.0);
        // 3.0 to -3.0 is 0.28 rad through pi, not 6 rad through 0.
        assert!(
            mid.heading > 3.0 && mid.heading < 3.0 + 0.29,
            "{}",
            mid.heading
        );
    }

    #[test]
    fn sample_at_interpolates_and_holds_at_the_ends() {
        let s = [
            Sample {
                t: 0.0,
                x: 0.0,
                y: 0.0,
                heading: 0.0,
            },
            Sample {
                t: 0.5,
                x: 10.0,
                y: -20.0,
                heading: 1.0,
            },
            Sample {
                t: 1.0,
                x: 30.0,
                y: -20.0,
                heading: 1.0,
            },
        ];
        assert_eq!(sample_at(&s, -1.0), s[0]);
        assert_eq!(sample_at(&s, 7.0), s[2]);
        assert_eq!(sample_at(&s, 0.5), s[1]);
        let q = sample_at(&s, 0.25);
        assert_eq!((q.t, q.x, q.y, q.heading), (0.25, 5.0, -10.0, 0.5));
        let q = sample_at(&s, 0.75);
        assert_eq!((q.x, q.y), (20.0, -20.0));
        assert_eq!(sample_at(&[], 0.3).t, 0.3, "no plan: no panic");
    }

    #[test]
    fn wrap_angle_lands_in_minus_pi_to_pi() {
        // pi and -pi are the same heading; rounding may give either.
        assert!((wrap_angle(3.0 * PI).abs() - PI).abs() < 1e-12);
        assert!((wrap_angle(-PI / 2.0) + PI / 2.0).abs() < 1e-12);
        assert!((wrap_angle(-6.0) - (2.0 * PI - 6.0)).abs() < 1e-12);
        assert_eq!(wrap_angle(0.0), 0.0);
    }

    #[test]
    fn the_default_planner_ends_at_the_act() {
        let s = default_planner().plan(&MoveRequest::new(
            Px::new(10.0, 10.0),
            Px::new(640.0, 360.0),
        ));
        let end = s.last().unwrap();
        assert!((end.x - 640.0).abs() < 1e-6 && (end.y - 360.0).abs() < 1e-6);
        assert_eq!(s[0].t, 0.0);
    }
}
