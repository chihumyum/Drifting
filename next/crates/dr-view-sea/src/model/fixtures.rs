//! What the model's tests share: three of the 0.1 client's passages
//! (`lib/char-sea/char-sea-text.ts`, written for Drifting), one for each kind
//! of cell (square CJK cells, narrow Latin ones, right-to-left Arabic ones),
//! and the repeatable stand-in for `Math.random` the 0.1 tests used.

use super::Language;

pub const ZH: Language = Language {
    cell_width: 10.0,
    cell_height: 10.0,
    rtl: false,
    text: "雾从港口那边漫过来的时候，林岚正把第三封信压在灯座底下。灯塔的铁梯被潮气浸得发凉，她每往上走一级，脚下就响一声，像有人在楼下跟着数。守塔人说今晚不会有船。她没有回答，只是把窗推开一道缝，让海风翻动桌上的信纸。纸角卷起来，露出背面一行很淡的铅笔字，那是她自己的笔迹，可她不记得什么时候写过。远处的雾笛响了两声，停了，又响了一声。她数着灯转过的圈数，数到第七圈的时候，海面上亮起一点很小的光，像有人在水底下划了一根火柴。那光不往岸边来，也不往外走，只在原地一明一灭。她想起父亲说过，雾最浓的夜里，旧码头会自己记起从前的船。信封上的邮戳已经洇开了，只剩一个“北”字还看得清。",
};

pub const EN: Language = Language {
    cell_width: 6.5,
    cell_height: 10.0,
    rtl: false,
    text: "The fog came in from the harbour while Lin was tucking the third letter under the lamp. The iron stairs of the lighthouse were cold with damp, and every step gave a small sound, as if someone below were counting. The keeper said no boats would come tonight. She did not answer. She opened the window a crack and let the sea wind turn the pages on the desk, and a corner lifted to show a faint line of pencil on the back, in her own hand, though she could not remember writing it. Far off the foghorn sounded twice, stopped, and sounded once more. On the seventh turn of the light a small glow rose on the water, as if someone under the sea had struck a match. ",
};

pub const AR: Language = Language {
    cell_width: 7.0,
    cell_height: 10.0,
    rtl: true,
    text: "جاء الضباب من جهة الميناء حين كانت لينا تضع الرسالة الثالثة تحت قاعدة المصباح. كان درج المنارة الحديدي باردا من الرطوبة، وكلما صعدت درجة سمعت صوتا خافتا، كأن أحدا في الأسفل يعد خطواتها. قال حارس المنارة إن السفن لن تأتي الليلة. لم تجب، بل فتحت النافذة قليلا وتركت ريح البحر تقلب الأوراق على الطاولة، فظهر على ظهر إحداها سطر باهت بالقلم الرصاص، بخطها هي، ولم تتذكر متى كتبته. من بعيد انطلق بوق الضباب مرتين، ثم سكت، ثم انطلق مرة أخرى. وفي الدورة السابعة للضوء لمع على الماء نور صغير، كأن أحدا تحت البحر أشعل عود ثقاب. ",
};

/// A repeatable stand-in for `Math.random` (the 0.1 tests' `seeded`).
pub fn seeded(seed: u64) -> Box<dyn FnMut() -> f32> {
    let mut state = seed;
    Box::new(move || {
        state = state * 16807 % 2_147_483_647;
        (state as f64 / 2_147_483_647.0) as f32
    })
}

/// How many steps `for (let i = 0; i < CHAR_SEA_STEP_RATE * seconds; i += 1)`
/// takes, counted in doubles as the 0.1 tests did.
pub fn steps(seconds: f64) -> usize {
    let limit = f64::from(super::STEP_RATE) * seconds;
    (0u32..).take_while(|i| f64::from(*i) < limit).count()
}

/// How many ticks `for (let t = 0; t < seconds; t += dt)` takes, counted in
/// doubles as the 0.1 tests did.
pub fn ticks(seconds: f64, dt: f64) -> usize {
    let mut t = 0.0;
    let mut count = 0;
    while t < seconds {
        t += dt;
        count += 1;
    }
    count
}
