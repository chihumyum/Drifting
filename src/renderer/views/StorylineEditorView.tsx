import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { useStoryline } from '../usecase/useStoryline';
import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { StorylineAllChapterEditor } from '../viewComponents/editor/StorylineAllChapterEditor';
import loglevel from "loglevel";
const log = loglevel.getLogger("StorylineEditorView");
log.setLevel(loglevel.levels.DEBUG);
// log.setLevel(loglevel.levels.WARN);

const DEFAULT_DOC = {
  type: 'doc',
  content: [],
};

export function StorylineEditorView() {
  const { projectId, storylineId } = useParams<{ projectId: string; storylineId: string }>();
  const user = useAuthStore(state => state.user);
  if (!projectId) {
    log.error('No projectId in params, cannot render storyline editor');
    throw new Error('No projectId in params');
  };
  if (!user) {
    log.error('No user in auth store, cannot render storyline editor');
    throw new Error('No user in auth store');
  };
  const { bookNodes, storylines } = useDataStore();
  const storylineUsecases = useStoryline({
    projectId: projectId,
    userId: user.id,
  });
  const loadedEditorRef = useRef<Editor | null>(null);
  const loadedStorylineRef = useRef<string | null>(null);
  const currentStoryline = useMemo(() => {
    if (!storylineId) {
      log.error('No storylineId in params, cannot find storyline');
      return null;
    };
    const found = storylines.find(sl => sl.id === storylineId);
    if (!found) {
      log.warn('Storyline not found for id:', storylineId);
      return null;
    }
    return found;
  }, [storylineId, storylines]);

  const currentNodes = useMemo(() => {
    if (!storylineId) {
      log.error('No storylineId in params, cannot find nodes');
      return [];
    };
    const found = bookNodes.filter(node => node.storylineIds.includes(storylineId));
    log.debug('Found nodes for storyline ', storylineId, found);
    return found;
  }, [storylineId, bookNodes]);
  const currentName = currentStoryline?.name ?? '';
  const currentSummary = currentStoryline?.summary ?? '';
  const [nameDraft, setNameDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [isComposingName, setIsComposingName] = useState(false);
  const [isComposingSummary, setIsComposingSummary] = useState(false);
  const displayedName = isEditingName ? nameDraft : currentName;
  const displayedSummary = isEditingSummary ? summaryDraft : currentSummary;

  // editor for storyline description
  const editorSL = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
        underline: false,
        link: false, // disable these two to avoid duplicate extensions warning
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      Placeholder.configure({
        placeholder: 'Empty',
      }),
      createDefaultSlashMenu(),
    ],
    content: null,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!storylineId) {
        log.warn('No storylineId, cannot save description update');
        return;
      }
      const json = ed.getJSON();
      void storylineUsecases.updateStoryline({
        id: storylineId,
        pmJson: JSON.stringify(json),
      });
    },
  }, [storylineId, storylineUsecases]);

  // load editor content when change storylines
  useEffect(() => {
    const alreadyLoadedForTarget =
      loadedStorylineRef.current === storylineId &&
      loadedEditorRef.current === editorSL;
    if (alreadyLoadedForTarget) {
      return;
    }
    if (!projectId || !storylineId) {
      log.warn('No projectId or storylineId, cannot load storyline content');
      return;
    }
    if (!editorSL || !currentStoryline) {
      log.warn('Editor or active storyline not ready yet');
      return;
    }
    loadedStorylineRef.current = storylineId;
    loadedEditorRef.current = editorSL;
    if (currentStoryline.descriptionJson) {
      try {
        const content = JSON.parse(currentStoryline.descriptionJson);
        log.debug('Loading storyline description content for storyline ', storylineId, content);
        editorSL.commands.setContent(content, { emitUpdate: false });
        return;
      } catch (error) {
        log.warn('Failed to parse storyline pmJson, fallback to empty doc:', error);
      }
    } else {
      log.warn('No pmJson content for storyline:', storylineId);
    }
    editorSL.commands.setContent(DEFAULT_DOC, { emitUpdate: false });
  }, [projectId, storylineId, editorSL, currentStoryline]);

  const commitName = async () => {
    if (!storylineId) return;
    if (nameDraft === currentName) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      name: nameDraft,
    });
  };
  const commitSummary = async () => {
    if (!storylineId) return;
    if (summaryDraft === currentSummary) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      summary: summaryDraft,
    });
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      position: 'relative',
      overflow: 'auto',
      paddingLeft: 64,
      paddingRight: 'auto',
      paddingTop: 16,
      paddingBottom: 16,
      scrollbarWidth: 'none',
    }}>
      {/* let the whole area scrollable */}
      <div>
        {/* Storyline Name */}
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="text"
            value={displayedName}
            onFocus={() => {
              setNameDraft(currentName);
              setIsEditingName(true);
            }}
            onChange={e => setNameDraft(e.target.value)}
            onCompositionStart={() => setIsComposingName(true)}
            onCompositionEnd={e => {
              setIsComposingName(false);
              setNameDraft(e.currentTarget.value);
            }}
            onBlur={() => {
              setIsEditingName(false);
              if (!isComposingName) {
                void commitName();
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isComposingName) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setNameDraft(currentName);
                e.currentTarget.blur();
              }
            }}
            style={{
              maxWidth: '50vw',
              fontSize: 32,
              fontWeight: 700,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              padding: '8px 0',
              color: 'rgba(0, 0, 0, 0.85)',
            }}
          />
        </div>

        {/* Description - Rich text editor */}
        <div style={{ marginBottom: 16, marginRight: '40%' }}>
          <input
            type="text"
            value={displayedSummary}
            onFocus={() => {
              setSummaryDraft(currentSummary);
              setIsEditingSummary(true);
            }}
            onChange={e => setSummaryDraft(e.target.value)}
            onCompositionStart={() => setIsComposingSummary(true)}
            onCompositionEnd={e => {
              setIsComposingSummary(false);
              setSummaryDraft(e.currentTarget.value);
            }}
            onBlur={() => {
              setIsEditingSummary(false);
              if (!isComposingSummary) {
                void commitSummary();
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isComposingSummary) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setSummaryDraft(currentSummary);
                e.currentTarget.blur();
              }
            }}
            placeholder='add a summary...'
            style={{
              maxWidth: '50vw',
              fontSize: 14,
              fontWeight: 400,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              padding: '8px 0',
              color: 'rgba(0, 0, 0, 0.85)',
            }}
          />

          <div>
            <EditorContent editor={editorSL} />
          </div>
        </div>

        <StorylineAllChapterEditor nodes={currentNodes} onCurrentChapterChange={() => { }} />

      </div>
    </div>
  );
}
