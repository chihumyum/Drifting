//! Book-wide relations share the canonical graph with relations modules.
use super::*;
use crate::dto::{RelationInfo, Target};
use dr_model::{
    kind::{EntityKind, RelationOrientation},
    shared::EntityRef,
};

pub(crate) fn register(r: &mut Registry) {
    r.add::<List>().add::<Create>().add::<Delete>();
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {
    pub book: String,
    #[serde(default)]
    pub entity: Option<Target>,
    #[serde(default)]
    pub relation_type: Option<String>,
}
op! {
    List="relation.list",Read,Shared,"List canonical relations whose endpoints are live, optionally scoped to an endpoint or type.",fn(cx,input:ListIn)->Vec<RelationInfo> {
        let s=cx.book_v3(&input.book)?;
        let endpoint=input.entity.as_ref().map(Target::to_ref);
        Ok(s.reader_v3.view().relations().iter()
            .filter(|r|endpoint.as_ref().is_none_or(|e|r.from==*e||r.to==*e))
            .filter(|r|input.relation_type.as_ref().is_none_or(|id|r.relation_type.as_str()==id))
            .map(RelationInfo::from).collect())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateIn {
    pub book: String,
    pub from: Target,
    pub to: Target,
    #[serde(default)]
    pub relation_type: Option<String>,
    /// An explicitly unused identity for author-side replay; Agent creation
    /// rejects this property before any reads or writes.
    #[serde(default)]
    pub id: Option<String>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Made {
    pub id: String,
    pub existing: bool,
}
op! {
    Create="relation.create",Write,Book,"Create a canonical relation, validating live endpoints and template restrictions; return an existing semantic edge without a write.",fn(cx,input:CreateIn)->Made {
        let s=cx.book_v3(&input.book)?;let v=s.reader_v3.view();
        let (mut from,mut to)=(input.from.to_ref(),input.to.to_ref());
        if !v.entity_exists(&from)||!v.entity_exists(&to)||from==to {return Err(WsError::invalid("relation needs distinct live endpoints"));}
        let ty=match &input.relation_type {
            Some(id)=>pid("relation type",id)?,
            None if matches!(from.kind,EntityKind::Comment|EntityKind::Material)=>dr_doc::catalog::generic_relation_type_id(&s.book),
            None=>return Err(WsError::invalid("relation_type is required")),
        };
        let ty=v.relation_type(&ty).ok_or_else(||WsError::not_found("relation type",ty.as_str()))?;
        let allows=|r:&EntityRef,kinds:&[EntityKind],templates:&[EntryTemplateId]| {
            (kinds.is_empty()||kinds.contains(&r.kind)) && (templates.is_empty() || (r.kind==EntityKind::Entry && EntryId::parse(&r.id).ok().and_then(|id|v.entry(&id)).is_some_and(|e|e.template.is_some_and(|id|templates.contains(&id)))))
        };
        if ty.orientation==RelationOrientation::Symmetric && from>to {std::mem::swap(&mut from,&mut to);}
        if !from.kind.may_start_relation() || !to.kind.is_structural() { return Err(WsError::invalid("unsupported canonical relation endpoint roles")); }
        if !allows(&from,&ty.source_kinds,&ty.source_templates)||!allows(&to,&ty.target_kinds,&ty.target_templates) {return Err(WsError::invalid("relation endpoints violate type restrictions"));}
        if let Some(old)=v.relations_raw().iter().find(|r|r.relation_type==ty.id&&((r.from==from&&r.to==to)||(ty.orientation==RelationOrientation::Symmetric&&r.from==to&&r.to==from))) {
            cx.undo_nothing();return Ok(Made{id:old.id.to_string(),existing:true});
        }
        let id=input.id.as_deref().map(|id|pid("relation",id)).transpose()?.unwrap_or_else(RelationId::new_v7);
        if v.relations_raw().iter().any(|r|r.id==id){return Err(WsError::invalid("relation identity is already stored"));}
        let saved=id.clone();
        let (_,at)=cx.write_book_v3(&s,move|t|{t.relation(&saved)?.ends(&from,&to)?.relation_type(&ty.id)?.created_at(Some(now()))?;Ok(())})?;
        undo(cx,&s,&at,vec![key("relations",&id)]);
        cx.effect(EffectAction::Created,"relation",id.as_str(),None);
        Ok(Made{id:id.to_string(),existing:false})
    }
}
op! {
    Delete="relation.delete",Write,Book,"Delete one canonical relation without deleting either endpoint.",fn(cx,input:EntityIn)->Done {
        let s=cx.book_v3(&input.book)?;let id:RelationId=pid("relation",&input.id)?;
        if !s.reader_v3.view().relations_raw().iter().any(|r|r.id==id){return Err(WsError::not_found("relation",&input.id));}
        let saved=id.clone();let (_,at)=cx.write_book_v3(&s,move|t|{t.purge(CollectionV3::Relations,saved.as_str())?;Ok(())})?;
        undo(cx,&s,&at,vec![key("relations",&id)]);cx.effect(EffectAction::Purged,"relation",&input.id,None);Ok(Done{id:input.id})
    }
}
