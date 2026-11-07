//! The sand masks (`assets/sand/`): seals, kind marks and their hollow
//! forms, the dry underline and highlight strokes, the frame box and the
//! wordmark. White alpha masks, tinted where they are drawn.

crate::assets::masks! {
    /// A sand mask.
    SandMask, "sand", "sand",
    Blob0 => "blob-0",
    Blob0Hollow => "blob-0-hollow",
    Blob1 => "blob-1",
    Blob1Hollow => "blob-1-hollow",
    Blob2 => "blob-2",
    Blob2Hollow => "blob-2-hollow",
    Blob3 => "blob-3",
    Blob3Hollow => "blob-3-hollow",
    Blob4 => "blob-4",
    Blob4Hollow => "blob-4-hollow",
    Blob5 => "blob-5",
    Blob5Hollow => "blob-5-hollow",
    FrameBox => "frame-box",
    Hl => "hl",
    HlHot => "hl-hot",
    MarkCorner => "mark-corner",
    MarkCornerHollow => "mark-corner-hollow",
    MarkDash => "mark-dash",
    MarkDashHollow => "mark-dash-hollow",
    MarkSlip => "mark-slip",
    MarkSlipHollow => "mark-slip-hollow",
    MarkSpiral => "mark-spiral",
    MarkSpiralHollow => "mark-spiral-hollow",
    MarkSquare => "mark-square",
    MarkSquareHollow => "mark-square-hollow",
    MarkStar => "mark-star",
    MarkStarHollow => "mark-star-hollow",
    MarkWave => "mark-wave",
    Ul => "ul",
    WordmarkDrifting => "wordmark-drifting",
}
