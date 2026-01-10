import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
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
import { Storyline } from '../domain/storyline';
import { BookNode } from '../domain/book-node';
const log = loglevel.getLogger("StorylineEditorView");
// log.setLevel(loglevel.levels.ERROR);
log.setLevel(loglevel.levels.TRACE);

// todo: 修复严重同步问题
export function StorylineEditorView() {
  const { projectId, storylineId } = useParams<{ projectId: string; storylineId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const { bookNodes, storylines } = useDataStore();
  const storylineUsecases = useStoryline();
  const [currentStoryline, setCurrentStoryline] = useState<Storyline | null>(null);
  const [currentNodes, setCurrentNodes] = useState<BookNode[]>([]);
  

  // get storyline and nodes from store
  useEffect(() => {
    if (!projectId || !storylineId) {
      log.error('Should load data when app started', { projectId, storylineId, user });
      return;
    }
    setCurrentStoryline(storylines.find(sl => sl.id === storylineId) || null);
    if (!currentStoryline) {
      log.warn('Current storyline not found in store, loading from DB...', storylineId);
    }
    setCurrentNodes(bookNodes.filter(node => node === storylineId));
    log.debug('Loaded storyline ', currentStoryline?.name, 'nodes ', currentNodes);
  }, [projectId, storylineId, user, navigate, storylines, bookNodes]);


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
        placeholder: 'Add a summary for this storyline...',
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
    if (!projectId || !storylineId) {
      log.warn('No projectId or storylineId, cannot load storyline content');
      return;
    }
    if (!editorSL || !currentStoryline) {
      log.debug('Editor or active storyline not ready yet');
      return;
    }
    if (currentStoryline.pmJson) {
      editorSL.commands.setContent(JSON.parse(currentStoryline.pmJson));
    } else {
      log.warn('No pmJson content for storyline:', storylineId);
      editorSL.commands.setContent(null);
    }
    
  }, [editorSL, projectId, storylineId, currentStoryline, currentNodes]);

  const handleUpdateName = async (newName: string) => {
    if (!storylineId) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      name: newName.trim(),
    });
  };
  const handleUpdateSummary = async (newSummary: string) => {
    if (!storylineId) return;
    await storylineUsecases.updateStoryline({
      id: storylineId,
      summary: newSummary.trim(),
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
              value={currentStoryline?.name || ''}
              onChange={e => handleUpdateName(e.target.value)}
              onBlur={e => handleUpdateName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleUpdateName(e.currentTarget.value);
                if (e.key === 'Escape') {
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
            value={currentStoryline?.summary || ''}
            onChange={e => handleUpdateSummary(e.target.value)}
            onBlur={e => handleUpdateSummary(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleUpdateSummary(e.currentTarget.value);
              if (e.key === 'Escape') {
                e.currentTarget.blur();
              }
            }}
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
