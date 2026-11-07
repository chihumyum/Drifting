//! A synthetic book, standing in for the workspace's data until F3's
//! queries arrive: enough chapters, storylines, elements, ideas and
//! materials to navigate, and a few paragraphs of made-up prose to show on
//! the paper (read-only; the editor arrives with F4e). Every word is
//! invented for this file.

use dr_model::id::{CategoryId, ElementId, MaterialId, NodeId, StorylineId};

use crate::nav::Target;
use crate::nav::location::{Catalog, Group};

pub struct Chapter {
    pub id: NodeId,
    pub title: &'static str,
    /// Index into [`StandIn::storylines`].
    pub storyline: usize,
    /// One of the six round seals.
    pub seal: u8,
}

pub struct Named<I> {
    pub id: I,
    pub name: &'static str,
}

pub struct StandIn {
    pub book_id: &'static str,
    pub title: &'static str,
    pub storylines: Vec<Named<StorylineId>>,
    pub chapters: Vec<Chapter>,
    pub categories: Vec<Named<CategoryId>>,
    /// (element, its category index).
    pub elements: Vec<(Named<ElementId>, usize)>,
    pub ideas: Vec<Named<NodeId>>,
    pub materials: Vec<Named<MaterialId>>,
}

fn id<I: std::str::FromStr>(s: &str) -> I
where
    I::Err: std::fmt::Debug,
{
    s.parse().expect("stand-in ids are valid")
}

const PROSE: [&str; 6] = [
    "退潮以后，码头上只剩下一排被海水泡白的木桩。林岚把船票折成四折，塞进外套最里面的口袋，像是怕它自己飞走。",
    "旧港的钟楼停在三点十七分，已经停了很多年。镇上的人说，钟是在最后一班渡船离开的那天停的，可谁也说不清那是哪一年。",
    "她沿着防波堤往东走。风从背后推着她，把远处灯塔的影子一下一下地推近，又在云遮住月亮的时候把它收回去。",
    "灯塔守望人的小屋亮着一盏灯。窗台上摆着一排玻璃瓶，瓶里装的不是信，是沙，每一瓶的颜色都不一样。",
    "“你来晚了。”门里的人没有回头，“潮水不等人，船也不等。”林岚没有说话，只是把那张折了四折的船票放在了桌上。",
    "很久以后她才明白，那天晚上真正被留下的，不是她，而是那一瓶还没有封口的、灰白色的沙。",
];

impl StandIn {
    pub fn sample() -> StandIn {
        let storylines = vec![
            Named {
                id: id("sl-tide"),
                name: "潮汐",
            },
            Named {
                id: id("sl-lighthouse"),
                name: "灯塔",
            },
        ];
        let chapter = |n: u8, title: &'static str, storyline: usize| Chapter {
            id: id(&format!("ch-{n}")),
            title,
            storyline,
            seal: n % 6,
        };
        let chapters = vec![
            chapter(1, "退潮", 0),
            chapter(2, "停摆的钟", 0),
            chapter(3, "防波堤", 1),
            chapter(4, "玻璃瓶", 1),
            chapter(5, "船票", 0),
            chapter(6, "灰白色的沙", 1),
        ];
        let categories = vec![
            Named {
                id: id("cat-people"),
                name: "人物",
            },
            Named {
                id: id("cat-places"),
                name: "地点",
            },
        ];
        let elements = vec![
            (
                Named {
                    id: id("el-linlan"),
                    name: "林岚",
                },
                0,
            ),
            (
                Named {
                    id: id("el-keeper"),
                    name: "守望人",
                },
                0,
            ),
            (
                Named {
                    id: id("el-harbour"),
                    name: "旧港",
                },
                1,
            ),
            (
                Named {
                    id: id("el-tower"),
                    name: "钟楼",
                },
                1,
            ),
        ];
        let ideas = vec![
            Named {
                id: id("idea-bell"),
                name: "雾里的钟声",
            },
            Named {
                id: id("idea-sand"),
                name: "每一瓶沙的来处",
            },
        ];
        let materials = vec![Named {
            id: id("mat-map"),
            name: "旧港地图",
        }];
        StandIn {
            book_id: "stand-in-book",
            title: "退潮",
            storylines,
            chapters,
            categories,
            elements,
            ideas,
            materials,
        }
    }

    /// The paragraphs of a chapter (the same made-up passage, rotated).
    pub fn paragraphs(&self, chapter: usize) -> impl Iterator<Item = &'static str> {
        (0..PROSE.len()).map(move |i| PROSE[(i + chapter) % PROSE.len()])
    }

    pub fn chapter_index(&self, node: &NodeId) -> Option<usize> {
        self.chapters.iter().position(|c| &c.id == node)
    }

    /// The name a tab or a page shows for `target`.
    pub fn title(&self, target: &Target) -> Option<&'static str> {
        match target {
            Target::Chapter(n) => self.chapters.iter().find(|c| &c.id == n).map(|c| c.title),
            Target::Idea(n) => self.ideas.iter().find(|i| &i.id == n).map(|i| i.name),
            Target::Storyline(s) => self.storylines.iter().find(|x| &x.id == s).map(|x| x.name),
            Target::Element(e) => self
                .elements
                .iter()
                .find(|(x, _)| &x.id == e)
                .map(|(x, _)| x.name),
            Target::Category(c) => self.categories.iter().find(|x| &x.id == c).map(|x| x.name),
            Target::Material(m) => self.materials.iter().find(|x| &x.id == m).map(|x| x.name),
            Target::Book => Some(self.title),
        }
    }

    pub fn exists(&self, target: &Target) -> bool {
        self.title(target).is_some()
    }

    fn targets(&self, group: Group) -> Vec<(Target, &'static str, String)> {
        match group {
            Group::Chapters => self
                .chapters
                .iter()
                .map(|c| (Target::Chapter(c.id.clone()), c.title, c.id.to_string()))
                .collect(),
            Group::Drifts => self
                .ideas
                .iter()
                .map(|i| (Target::Idea(i.id.clone()), i.name, i.id.to_string()))
                .collect(),
            Group::Elements => self
                .elements
                .iter()
                .map(|(e, _)| (Target::Element(e.id.clone()), e.name, e.id.to_string()))
                .collect(),
            Group::Categories => self
                .categories
                .iter()
                .map(|c| (Target::Category(c.id.clone()), c.name, c.id.to_string()))
                .collect(),
            Group::Storylines => self
                .storylines
                .iter()
                .map(|s| (Target::Storyline(s.id.clone()), s.name, s.id.to_string()))
                .collect(),
        }
    }
}

impl Catalog for StandIn {
    fn book_id(&self) -> Option<&str> {
        Some(self.book_id)
    }

    fn by_name(&self, group: Group, name: &str) -> Vec<Target> {
        self.targets(group)
            .into_iter()
            .filter(|(_, n, _)| *n == name)
            .map(|(t, ..)| t)
            .collect()
    }

    fn by_id(&self, group: Group, id: &str) -> Option<Target> {
        self.targets(group)
            .into_iter()
            .find(|(.., i)| i == id)
            .map(|(t, ..)| t)
    }
}
