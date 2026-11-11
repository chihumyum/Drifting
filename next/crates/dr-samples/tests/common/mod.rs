#![allow(dead_code)]
//! Explicit fixture-only profile marker for `MappingChoices`.
use dr_samples::v3::*;
pub fn test_choices(_source: &dr_samples::SeededBook) -> MappingChoices {
    MappingChoices {
        profile: Some("test-explicit".into()),
    }
}
