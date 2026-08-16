import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  GENERIC_ASSOCIATION_SYSTEM_KEY,
  type EntityRelationType,
} from '../domain/entity-relation-type';

export interface EntityRelationTypePresentation {
  name: string;
  description: string;
  sourceRole: string;
  targetRole: string;
}

/** Resolve locale-dependent copy without changing the canonical persisted
 * relation-type definition. Authored relation types are displayed verbatim. */
export function useRelationTypePresentation() {
  const { t } = useTranslation();

  return useCallback(
    (type: EntityRelationType): EntityRelationTypePresentation => {
      if (type.systemKey !== GENERIC_ASSOCIATION_SYSTEM_KEY) {
        return {
          name: type.name,
          description: type.description,
          sourceRole: type.sourceRole,
          targetRole: type.targetRole,
        };
      }
      return {
        name: t('relationTypes.genericAssociation.name'),
        description: t('relationTypes.genericAssociation.description'),
        sourceRole: t('relationTypes.genericAssociation.sourceRole'),
        targetRole: t('relationTypes.genericAssociation.targetRole'),
      };
    },
    [t],
  );
}
