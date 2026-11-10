/// Why storing a book failed.
#[derive(Debug)]
pub enum WriteError {
    Doc(dr_doc::DocError),
    Store(dr_store::StoreError),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Doc(e) => write!(f, "{e}"),
            WriteError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<dr_doc::DocError> for WriteError {
    fn from(e: dr_doc::DocError) -> Self {
        WriteError::Doc(e)
    }
}

impl From<dr_store::StoreError> for WriteError {
    fn from(e: dr_store::StoreError) -> Self {
        WriteError::Store(e)
    }
}
