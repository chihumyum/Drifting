//! Dates as the shelf wrote them in the interface language (counts are
//! `dr_i18n::number`). Months and days are `toLocaleString` /
//! `toLocaleDateString` of the 0.1 client's `views/shelf/shelf-format.ts`,
//! written out for the nine interface languages.

use dr_i18n::Locale;

/// (year, month 1–12, day) of `YYYY-MM-DD`.
pub fn ymd(day: &str) -> (i64, usize, u32) {
    let part = |r: std::ops::Range<usize>| day.get(r).and_then(|s| s.parse().ok());
    (
        part(0..4).unwrap_or(1970),
        part(5..7).unwrap_or(1).clamp(1, 12) as usize,
        part(8..10).unwrap_or(1) as u32,
    )
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
pub fn day_number(day: &str) -> i64 {
    let (y, m, d) = ymd(day);
    let (m, d) = (m as i64, i64::from(d));
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `n` days after 1970-01-01, `YYYY-MM-DD`.
pub fn day_of_number(n: i64) -> String {
    let z = n + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 0 for Monday … 6 for Sunday.
pub fn weekday(day: &str) -> usize {
    // 1970-01-01 was a Thursday.
    (day_number(day) + 3).rem_euclid(7) as usize
}

const SHORT_MONTHS: [(Locale, [&str; 12]); 6] = [
    (
        Locale::En,
        [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ],
    ),
    (
        Locale::Es,
        [
            "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic",
        ],
    ),
    (
        Locale::De,
        [
            "Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
        ],
    ),
    (
        Locale::Fr,
        [
            "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.",
            "nov.", "déc.",
        ],
    ),
    (
        Locale::PtBr,
        [
            "jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.",
            "dez.",
        ],
    ),
    (
        Locale::Ko,
        [
            "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월",
        ],
    ),
];

const LONG_MONTHS: [(Locale, [&str; 12]); 5] = [
    (
        Locale::En,
        [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ],
    ),
    (
        Locale::Es,
        [
            "enero",
            "febrero",
            "marzo",
            "abril",
            "mayo",
            "junio",
            "julio",
            "agosto",
            "septiembre",
            "octubre",
            "noviembre",
            "diciembre",
        ],
    ),
    (
        Locale::De,
        [
            "Januar",
            "Februar",
            "März",
            "April",
            "Mai",
            "Juni",
            "Juli",
            "August",
            "September",
            "Oktober",
            "November",
            "Dezember",
        ],
    ),
    (
        Locale::Fr,
        [
            "janvier",
            "février",
            "mars",
            "avril",
            "mai",
            "juin",
            "juillet",
            "août",
            "septembre",
            "octobre",
            "novembre",
            "décembre",
        ],
    ),
    (
        Locale::PtBr,
        [
            "janeiro",
            "fevereiro",
            "março",
            "abril",
            "maio",
            "junho",
            "julho",
            "agosto",
            "setembro",
            "outubro",
            "novembro",
            "dezembro",
        ],
    ),
];

/// Monday first, as the date's own format writes them.
fn weekday_name(locale: Locale, w: usize) -> &'static str {
    let names: [&str; 7] = match locale {
        Locale::ZhCn => ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
        Locale::ZhTw => ["週一", "週二", "週三", "週四", "週五", "週六", "週日"],
        Locale::Ja => ["月", "火", "水", "木", "金", "土", "日"],
        Locale::Ko => ["월", "화", "수", "목", "금", "토", "일"],
        Locale::En => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        Locale::Es => ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
        Locale::De => ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."],
        Locale::Fr => ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
        Locale::PtBr => ["seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."],
    };
    names[w.min(6)]
}

/// The heat map's month under a week's column: 11月, Nov.
pub fn month(day: &str, locale: Locale) -> String {
    let (_, m, _) = ymd(day);
    match locale {
        Locale::ZhCn | Locale::ZhTw | Locale::Ja => format!("{m}月"),
        _ => SHORT_MONTHS
            .iter()
            .find(|(l, _)| *l == locale)
            .map_or_else(|| m.to_string(), |(_, names)| names[m - 1].to_owned()),
    }
}

/// A day as the heat map's hover card heads it: 11月2日周一, Mon, November 2.
pub fn day(day: &str, locale: Locale) -> String {
    let (_, m, d) = ymd(day);
    let w = weekday_name(locale, weekday(day));
    let long = || {
        LONG_MONTHS
            .iter()
            .find(|(l, _)| *l == locale)
            .map_or_else(|| m.to_string(), |(_, names)| names[m - 1].to_owned())
    };
    match locale {
        Locale::ZhCn | Locale::ZhTw => format!("{m}月{d}日{w}"),
        Locale::Ja => format!("{m}月{d}日({w})"),
        Locale::Ko => format!("{m}월 {d}일 ({w})"),
        Locale::En => format!("{w}, {} {d}", long()),
        Locale::Es => format!("{w}, {d} de {}", long()),
        Locale::De => format!("{w}, {d}. {}", long()),
        Locale::Fr => format!("{w} {d} {}", long()),
        Locale::PtBr => format!("{w}, {d} de {}", long()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_read_as_the_old_shelf_wrote_them() {
        assert_eq!(weekday("2024-01-01"), 0);
        assert_eq!(weekday("2024-11-23"), 5);
        assert_eq!(day_of_number(day_number("2024-02-29") + 1), "2024-03-01");
        assert_eq!(day("2024-11-23", Locale::ZhCn), "11月23日周六");
        assert_eq!(day("2024-11-23", Locale::En), "Sat, November 23");
        assert_eq!(day("2024-11-23", Locale::De), "Sa., 23. November");
        assert_eq!(day("2024-11-23", Locale::PtBr), "sáb., 23 de novembro");
        assert_eq!(month("2024-11-01", Locale::ZhCn), "11月");
        assert_eq!(month("2024-11-01", Locale::Fr), "nov.");
    }
}
