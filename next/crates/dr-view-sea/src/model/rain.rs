//! The loading rain: drops running down the sheet's columns.

// The rain keeps about this share of columns falling, each drop 11–31 cells a
// second with a trail of 7–27 cells. A head the water knocks further than
// RAIN_BREAK from its rest breaks the drop.
const RAIN_DENSITY: f32 = 0.3;
const RAIN_BREAK: f32 = 0.2;

/// `Math.round`: the nearest whole number, halves towards +∞ (so -2.5 → -2,
/// where Rust's `round` gives -3).
pub(super) fn js_round(x: f32) -> f32 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// A 0–255 brightness as a byte, rounded as `Math.round` rounds.
fn to_byte(value: f32) -> u8 {
    js_round(value).clamp(0.0, 255.0) as u8
}

struct RainDrop {
    /// Row of the head, in cells from the top (fractional).
    y: f32,
    speed: f32,
    length: f32,
    fade: f32,
    broken: bool,
}

struct Column {
    drops: Vec<RainDrop>,
    wait: f32,
}

/// The loading rain: drops run down the sheet's columns, a lit head and a
/// trail that fades behind it, lighting each cell's own character as they
/// pass. A column holds at most two drops. A drop whose head the water knocks
/// breaks and fades, and its column lets a new one fall from the top a moment
/// later, so the rain comes back by itself. Stopped, no new drops fall and
/// those out fade in about half a second.
pub struct Rain {
    pub cols: usize,
    pub rows: usize,
    /// Per cell, row by row: how lit its trail is, then whether a head is on
    /// it (0–255 each, interleaved; `cols * rows * 2` long).
    pub cells: Vec<u8>,
    columns: Vec<Column>,
    falling: bool,
    level: f32,
    random: Box<dyn FnMut() -> f32>,
}

impl Rain {
    /// No rain yet over a sheet of `cols × rows` cells. `random` gives 0..1,
    /// as `Math.random` does (`Rand::boxed` in production).
    pub fn new(cols: usize, rows: usize, random: Box<dyn FnMut() -> f32>) -> Rain {
        Rain {
            cols,
            rows,
            cells: vec![0; cols * rows * 2],
            columns: Vec::new(),
            falling: false,
            level: 0.0,
            random,
        }
    }

    /// Whether new drops are falling (started and not stopped).
    pub fn raining(&self) -> bool {
        self.falling
    }

    /// How long a drop takes to run down the sheet, about.
    fn life(&self) -> f32 {
        (self.rows as f32 + 17.0) / 21.0
    }

    /// The wait between one column's drops that keeps RAIN_DENSITY falling.
    fn gap(&self) -> f32 {
        (self.life() * (1.0 - RAIN_DENSITY)) / RAIN_DENSITY
    }

    /// Begins: about the density's share of columns start within 0.9s, the
    /// rest later.
    pub fn start(&mut self) {
        if self.falling {
            return;
        }
        self.falling = true;
        let gap = self.gap();
        let random = &mut self.random;
        self.columns = (0..self.cols)
            .map(|_| Column {
                drops: Vec::new(),
                wait: if random() < RAIN_DENSITY {
                    random() * 0.9
                } else {
                    random() * gap
                },
            })
            .collect();
    }

    /// No new drops fall; those out fade.
    pub fn stop(&mut self) {
        self.falling = false;
    }

    /// Moves the rain on by `dt` seconds and lights `cells`. `off_rest(col,
    /// row)` is how far the water under a head (`row` fractional, in cells)
    /// stands from its rest. Returns whether anything is still falling or lit.
    pub fn tick(&mut self, dt: f32, mut off_rest: impl FnMut(usize, f32) -> f32) -> bool {
        let (to, tau) = if self.falling {
            (1.0, 0.05)
        } else {
            (0.0, 0.1)
        };
        self.level += (to - self.level) * (1.0 - (-dt / tau).exp());
        self.cells.fill(0);
        if !self.falling && self.level < 0.01 {
            // faded out: the drops still out go with it
            self.level = 0.0;
            self.columns.clear();
            return false;
        }
        let gap = self.gap();
        let (cols, rows, falling, level) = (self.cols, self.rows, self.falling, self.level);
        let Rain {
            columns,
            cells,
            random,
            ..
        } = self;
        let mut lit = false;
        for (col, column) in columns.iter_mut().enumerate() {
            column.wait -= dt;
            let room = column
                .drops
                .last()
                .is_none_or(|last| last.y - last.length > 2.0);
            if falling && column.wait <= 0.0 && column.drops.len() < 2 && room {
                column.drops.push(RainDrop {
                    y: -random() * 4.0,
                    speed: 11.0 + random() * 20.0,
                    length: 7.0 + random() * 20.0,
                    fade: 1.0,
                    broken: false,
                });
                column.wait = gap * (0.3 + random() * 1.4);
            }
            // newest first, as the 0.1 client ran them
            let mut k = column.drops.len();
            while k > 0 {
                k -= 1;
                let drop = &mut column.drops[k];
                drop.y += drop.speed * dt;
                if !drop.broken && off_rest(col, drop.y).abs() > RAIN_BREAK {
                    drop.broken = true;
                    column.wait = column.wait.min(0.25 + random() * 0.9);
                }
                if drop.broken {
                    drop.fade -= dt * 4.0;
                }
                if drop.fade <= 0.0 || drop.y - drop.length > rows as f32 {
                    column.drops.remove(k);
                    continue;
                }
                lit = true;
                let head = drop.y.floor() as i64;
                let strength = drop.fade * level;
                let from = (head - drop.length.ceil() as i64).max(0);
                let to = head.min(rows as i64 - 1);
                for row in from..=to {
                    let trail = (1.0 - (drop.y - row as f32) / drop.length).max(0.0);
                    let at = (row as usize * cols + col) * 2;
                    let Some(cell) = cells.get_mut(at..at + 2) else {
                        continue;
                    };
                    cell[0] = cell[0].max(to_byte(255.0 * strength * trail.powf(1.25)));
                    if row == head {
                        cell[1] = cell[1].max(to_byte(255.0 * strength));
                    }
                }
            }
        }
        lit || falling
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fixtures::{seeded, ticks};

    /// How much light the rain lays on its columns in `from..to`.
    fn lit_amount(rain: &Rain, from: usize, to: usize) -> u32 {
        let mut sum = 0;
        for row in 0..rain.rows {
            for col in from..to {
                sum += u32::from(rain.cells[(row * rain.cols + col) * 2]);
            }
        }
        sum
    }

    /// How many of the rain's columns in `from..to` have a lit cell.
    fn lit_columns(rain: &Rain, from: usize, to: usize) -> usize {
        (from..to)
            .filter(|col| (0..rain.rows).any(|row| rain.cells[(row * rain.cols + col) * 2] > 0))
            .count()
    }

    /// Ticks at 60 frames a second for `seconds`.
    fn run(rain: &mut Rain, seconds: f64, off_rest: impl Fn(usize) -> f32) -> bool {
        let mut still = false;
        for _ in 0..ticks(seconds, 1.0 / 60.0) {
            still = rain.tick(1.0 / 60.0, |col, _| off_rest(col));
        }
        still
    }

    #[test]
    fn rounds_as_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(0.49999997), 0.0);
        assert_eq!(js_round(254.5), 255.0);
        assert_eq!(js_round(-3.7), -4.0);
    }

    #[test]
    fn rains_down_about_a_third_of_the_columns_breaks_the_drops_the_water_knocks_and_refills_them()
    {
        let mut rain = Rain::new(60, 40, seeded(7));
        rain.start();
        assert!(rain.raining());
        run(&mut rain, 6.0, |_| 0.0);
        let falling = lit_columns(&rain, 0, 60);
        assert!(falling as f32 > 60.0 * 0.15, "{falling}");
        assert!((falling as f32) < 60.0 * 0.6, "{falling}");
        assert!(
            rain.cells
                .iter()
                .enumerate()
                .any(|(index, value)| index % 2 == 1 && *value == 255)
        );

        // Drops that still fall in break at once, so only their first instant shows.
        run(&mut rain, 1.0, |col| if col < 30 { 1.0 } else { 0.0 });
        let knocked = lit_amount(&rain, 0, 30);
        let calm = lit_amount(&rain, 30, 60);
        assert!((knocked as f32) < calm as f32 * 0.25, "{knocked} vs {calm}");

        run(&mut rain, 4.0, |_| 0.0);
        let back = lit_columns(&rain, 0, 30);
        assert!(back as f32 > 30.0 * 0.15, "{back}");
    }

    #[test]
    fn stops_the_rain_nothing_new_falls_and_what_is_out_fades_within_half_a_second() {
        let mut rain = Rain::new(40, 30, seeded(3));
        rain.start();
        run(&mut rain, 4.0, |_| 0.0);
        assert!(lit_columns(&rain, 0, 40) > 0);
        rain.stop();
        assert!(!rain.raining());
        let still = run(&mut rain, 0.5, |_| 0.0);
        assert!(!still);
        assert_eq!(lit_columns(&rain, 0, 40), 0);
    }
}
