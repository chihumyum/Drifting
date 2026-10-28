import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { flattenMaterialFolders } from '../../domain/material-folder';
import { useDataStore } from '../../store/data-store';
import { useMaterialFolder } from '../../usecase/useMaterialFolder';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { BrushIcon } from '../../components/ui/BrushIcon';

/** Chooses a material folder (or the root) to move materials and folders into. */
export function MaterialFolderPicker({
  projectId,
  currentFolderId,
  disabledFolderIds,
  onClose,
  onPick,
}: {
  projectId: string;
  /** Where the material is now; shown as the current choice. */
  currentFolderId: string | null;
  /** Folders being moved and everything below them: not a destination. */
  disabledFolderIds?: ReadonlySet<string>;
  onClose: () => void;
  onPick: (folderId: string | null) => void;
}) {
  const { t } = useTranslation();
  const folders = useDataStore((state) => state.materialFolders);
  const folderUsecases = useMaterialFolder(projectId);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rows = flattenMaterialFolders(folders);

  const createAndPick = async () => {
    if (!name.trim()) return;
    try {
      const folder = await folderUsecases.createFolder({ name });
      onPick(folder.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  return (
    <ModalRoot onClose={onClose} ariaLabel={t('materialFolders.picker.title')}>
      <ModalCard width="min(420px, 92vw)">
        <ModalHeader title={t('materialFolders.picker.title')} onClose={onClose} closeLabel={t('common.close')} />
        <ModalBody>
          <div className="material-folder-picker" role="listbox" aria-label={t('materialFolders.picker.title')}>
            <button
              type="button"
              role="option"
              aria-selected={currentFolderId === null}
              className={`material-folder-picker__row${currentFolderId === null ? ' material-folder-picker__row--current' : ''}`}
              onClick={() => onPick(null)}
            >
              <BrushIcon name="folder-open" size={13} />
              <span>{t('materialFolders.root')}</span>
            </button>
            {rows.map(({ folder, depth }) => (
              <button
                key={folder.id}
                type="button"
                role="option"
                aria-selected={currentFolderId === folder.id}
                aria-disabled={disabledFolderIds?.has(folder.id) || undefined}
                disabled={disabledFolderIds?.has(folder.id)}
                className={`material-folder-picker__row${currentFolderId === folder.id ? ' material-folder-picker__row--current' : ''}`}
                style={{ paddingLeft: 10 + (depth + 1) * 14 }}
                onClick={() => onPick(folder.id)}
              >
                <BrushIcon name="folder" size={13} />
                <span>{folder.name}</span>
              </button>
            ))}
          </div>
          <form
            className="material-folder-picker__new"
            onSubmit={(event) => {
              event.preventDefault();
              void createAndPick();
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('materialFolders.picker.newPlaceholder')}
              aria-label={t('materialFolders.picker.newPlaceholder')}
            />
            <button type="submit" disabled={!name.trim()}>
              {t('materialFolders.picker.createAndMove')}
            </button>
          </form>
          {error && <div className="material-folder-picker__error">{error}</div>}
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}
