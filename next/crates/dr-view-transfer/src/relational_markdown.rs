//! Export every live project in the library as a relational Markdown ZIP
//! archive (Settings → 本地数据 「导出 Markdown ZIP」).

use std::time::SystemTime;

use dr_i18n::keys;
use gpui::App;

use crate::book::start_dir;
use crate::dialog::{State, TransferDialog};

use keys::settings::account as k;

pub fn export_all(cx: &mut App) {
    let Some(lib) = cx
        .try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone())
    else {
        return;
    };
    let suggested = dr_export::relational_markdown::relational_markdown_filename(SystemTime::now());
    let prompt = cx.prompt_for_new_path(&start_dir(), Some(&suggested));
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(mut path))) = prompt.await else {
            return;
        };
        if path.extension().is_none() {
            path.set_extension("zip");
        }
        let dialog = cx.update(|cx| {
            let working = dr_shell::Strings::get(cx).t(k::EXPORTING).to_owned();
            TransferDialog::show(
                State::Working {
                    title: k::EXPORT_ALL,
                    name: working,
                    progress: None,
                },
                cx,
            )
        });
        let result = cx
            .background_executor()
            .spawn(async move {
                dr_export::relational_markdown::export_all_to_zip(&lib, &path, SystemTime::now())
            })
            .await;
        cx.update(|cx| {
            dialog.update(cx, |d, cx| match result {
                Ok(summary) => {
                    let text = d.i18n.fmt(k::EXPORT_DONE, &[("count", &summary.documents)]);
                    d.set(
                        State::Done {
                            title: k::EXPORT_ALL,
                            text,
                        },
                        cx,
                    );
                }
                Err(error) => {
                    let text = d
                        .i18n
                        .fmt(k::EXPORT_FAILED, &[("error", &error.to_string())]);
                    d.set(
                        State::Failed {
                            title: k::EXPORT_ALL,
                            reason: k::EXPORT_FAILED,
                            text,
                        },
                        cx,
                    );
                }
            });
        });
    })
    .detach();
}
