//! The sea's random numbers.

/// The largest f32 below 1.
const BELOW_ONE: f32 = 1.0 - f32::EPSILON / 2.0;

/// mulberry32, the seeded generator the 0.1 client used where it wanted
/// repeatable numbers: 0..1, the same numbers as JavaScript's for the same
/// seed, to f32 precision. Production seeds it from the clock; tests seed it
/// with a constant.
#[derive(Clone, Debug)]
pub struct Rand(u32);

impl Rand {
    /// A generator that starts from `seed`.
    pub fn new(seed: u32) -> Rand {
        Rand(seed)
    }

    /// The next number in 0..1. `((t ^ (t >>> 14)) >>> 0) / 4294967296` can
    /// round up to 1 as an f32; it is kept just below, as `Math.random` is.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((f64::from(t ^ (t >> 14)) / 4_294_967_296.0) as f32).min(BELOW_ONE)
    }

    /// The generator as the `random` the rain and the glyphs take.
    pub fn boxed(self) -> Box<dyn FnMut() -> f32> {
        let mut rand = self;
        Box::new(move || rand.next())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_the_numbers_javascript_draws() {
        // mulberry32(1) in JavaScript.
        let mut rand = Rand::new(1);
        let expected = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522];
        for want in expected {
            let got = rand.next();
            assert!((f64::from(got) - want).abs() < 1e-7, "{got} vs {want}");
        }
        let mut boxed = Rand::new(1).boxed();
        assert_eq!(boxed(), Rand::new(1).next());
    }

    #[test]
    fn stays_below_one() {
        assert_eq!(BELOW_ONE.to_bits(), 0x3f7f_ffff);
        let mut rand = Rand::new(0xdead_beef);
        assert!(
            (0..10_000)
                .map(|_| rand.next())
                .all(|r| (0.0..1.0).contains(&r))
        );
    }
}
