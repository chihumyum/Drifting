//! G1's mounted editor navigation. Async block lookup retains the originating
//! library/book and checks them again before opening a versioned shell URL.
use gpui::App;

pub fn init(cx: &mut App) {
    dr_editor::file_host::set_host(
        cx,
        dr_editor::file_host::EditorFileCallbacks {
            strings: std::rc::Rc::new(|cx| {
                use dr_i18n::keys::v5_files as k;
                dr_editor::file_host::EditorFileStrings {
                    slash_image_or_pdf: dr_shell::t(cx, k::SLASH_IMAGE_OR_PDF),
                    find_file: dr_shell::t(cx, k::FIND_FILE),
                    all_folders: dr_shell::t(cx, k::ALL_FOLDERS),
                    pick_from_computer: dr_shell::t(cx, k::PICK_FROM_COMPUTER),
                    empty: dr_shell::t(cx, k::EMPTY),
                    prose_caption_placeholder: dr_shell::t(cx, k::PROSE_CAPTION_PLACEHOLDER),
                    size_heading: dr_shell::t(cx, k::SIZE_HEADING),
                    size_small: dr_shell::t(cx, k::SIZE_SMALL),
                    size_medium: dr_shell::t(cx, k::SIZE_MEDIUM),
                    size_full: dr_shell::t(cx, k::SIZE_FULL),
                    align_heading: dr_shell::t(cx, k::ALIGN_HEADING),
                    align_left: dr_shell::t(cx, k::ALIGN_LEFT),
                    align_center: dr_shell::t(cx, k::ALIGN_CENTER),
                    align_right: dr_shell::t(cx, k::ALIGN_RIGHT),
                    open: dr_shell::t(cx, k::OPEN),
                    locate_in_library: dr_shell::t(cx, k::LOCATE_IN_LIBRARY),
                    remove_from_prose: dr_shell::t(cx, k::REMOVE_FROM_PROSE),
                    restore: dr_shell::t(cx, k::RESTORE),
                    kind_image: dr_shell::t(cx, k::KIND_IMAGE),
                    kind_pdf: dr_shell::t(cx, k::KIND_PDF),
                    write_comment: dr_shell::t(cx, dr_i18n::keys::v3_review::WRITE_COMMENT),
                    draw_region_comment: dr_shell::t(
                        cx,
                        dr_i18n::keys::v3_review::DRAW_REGION_COMMENT,
                    ),
                }
            }),
            format_page_count: std::rc::Rc::new(|pages, cx| {
                dr_shell::strings::tp(cx, dr_i18n::keys::v5_files::PAGE_COUNT, pages as u64, &[])
                    .to_string()
            }),
            pasted_image_title: std::rc::Rc::new(|cx| {
                let prefix = dr_shell::t(cx, dr_i18n::keys::v5_files::PASTED_IMAGE);
                dr_view_material::import::pasted_image_title(prefix.as_ref())
            }),
            import_paths: std::sync::Arc::new(Box::new(|ws, book, paths| {
                dr_view_material::import::import_paths(ws, book, None, paths)
                    .imported
                    .into_iter()
                    .map(|imp| dr_editor::file_host::ImportedFile {
                        id: imp.material,
                        reused: imp.reused,
                    })
                    .collect()
            })),
            import_bytes: std::sync::Arc::new(Box::new(|ws, book, bytes, title| {
                dr_view_material::import::import_bytes(ws, book, None, bytes, title).map(|imp| {
                    dr_editor::file_host::ImportedFile {
                        id: imp.material,
                        reused: imp.reused,
                    }
                })
            })),
            pdf_pages: std::sync::Arc::new(Box::new(|ws, asset_id| {
                let source = ws
                    .library()
                    .asset(asset_id, dr_store::asset::Variant::Source)
                    .ok()??;
                let bytes = std::fs::read(&source.path).ok()?;
                dr_view_material::media::PdfDoc::open(bytes)
                    .ok()
                    .map(|d| d.pages.len())
            })),
            locate_in_library: std::rc::Rc::new(|asset_id, _window, cx| {
                let id = asset_id.to_owned();
                dr_shell::workspace::with_workspace(cx, move |_, window, cx| {
                    let weak = cx.weak_entity();
                    dr_shell::pages::locate_asset(&weak, &id, window, cx);
                });
            }),
            trigger_flash: std::rc::Rc::new(|keys, cx| {
                dr_shell::pages::UsageFlash::trigger(keys, cx);
            }),
            flash_active: std::rc::Rc::new(|keys, window, cx| {
                dr_shell::pages::UsageFlash::strength_for(keys, window, cx) > 0.0
            }),
        },
    );
    dr_editor::links::set_clipboard_refusal(cx, |cx| {
        dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
            let text = dr_shell::t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED);
            ws.toast_error(text, cx);
        });
    });
    dr_editor::links::set_v3_opener(cx, |library, book, link, cx| {
        if dr_shell::release::is_releasing(cx) {
            return;
        }
        let library = library.clone();
        let book = book.to_owned();
        let scope = std::ptr::from_ref(library.library()) as usize;
        let window = dr_shell::workspace::active_workspace(cx);
        if matches!(
            link.kind,
            dr_model::kind::EntityKind::Asset | dr_model::kind::EntityKind::Material
        ) {
            let asset_id = link.target.clone();
            let check_lib = library.clone();
            let check_book = book.clone();
            let check_id = asset_id.clone();
            let resolved = cx.background_executor().spawn(async move {
                dr_editor::v3::read(&check_lib, &check_book, move |v| {
                    v.assets().iter().any(|a| a.id.as_str() == check_id)
                })
                .ok()
                .filter(|alive| *alive)
                .and_then(|_| dr_model::id::MediaItemId::parse(&asset_id).ok())
            });
            cx.spawn(async move |cx| {
                let Some(id) = resolved.await else {
                    return;
                };
                let Some(window) = window else {
                    return;
                };
                cx.update(|cx| {
                    dr_shell::workspace::update_workspace(window, cx, move |ws, _, cx| {
                        if dr_shell::release::is_releasing(cx)
                            || ws.book_id != book
                            || ws.library.as_ref().is_none_or(|lib| {
                                std::ptr::from_ref(lib.library()) as usize != scope
                            })
                        {
                            return;
                        }
                        ws.open(
                            dr_shell::nav::Target::Material(id),
                            dr_shell::nav::Open::PREVIEW,
                            cx,
                        );
                    })
                });
            })
            .detach();
            return;
        }
        let resolved = cx.background_executor().spawn(async move {
            dr_editor::v3_link::resolve(&library, &book, &link).map(|address| (book, address))
        });
        cx.spawn(async move |cx| {
            let Ok((book, address)) = resolved.await else {
                return;
            };
            let Some(window) = window else {
                return;
            };
            cx.update(|cx| {
                dr_shell::workspace::update_workspace(window, cx, move |ws, window, cx| {
                    if dr_shell::release::is_releasing(cx)
                        || ws.book_id != book
                        || ws
                            .library
                            .as_ref()
                            .is_none_or(|lib| std::ptr::from_ref(lib.library()) as usize != scope)
                    {
                        return;
                    }
                    let href = address.format("drifting");
                    ws.open_link(&href, window, cx);
                })
            });
        })
        .detach();
    });
}
