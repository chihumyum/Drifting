import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { createDefaultSlashMenu } from '@chi-hum/tiptap-simple-slash-menu'
import type { CSSProperties, ComponentType, Ref, FC } from 'react'
import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../../store'
import { query, run } from '../../lib/db'
import { debounce } from '../../utils/debounce'
import { events } from '../../lib/events'
import type { ContentBlock, StoryNode } from '../../schema/table'


type PanelKey = 'format' | 'info' | 'page' | 'inspector' | 'todo' | 'snippets'

export const EditorView: FC = () => {
  const {
    selectedChapterId: selectedNodeId,
    currentNodeId,
    setCurrentNodeId,
    setBlocks,
    addBlock,
    updateBlock,
  } = useAppStore()
  const navigate = useNavigate()

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      createDefaultSlashMenu(),
    ],
    content: '<p>开始写作...</p>',
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none min-h-[400px]',
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const text = ed.getText()
      if (selectedNodeId && text.trim()) {
        saveContent(selectedNodeId, ed.getJSON(), text)
      }
    },
  })

  const saveContent = useMemo(
    () => debounce(async (nodeId: string, pmJson: Record<string, unknown>, plainText: string) => {
      try {
        const existingBlocks = await query<ContentBlock>(
          `SELECT * FROM node_block WHERE node_id = '${nodeId}' ORDER BY order_index`
        )

        if (existingBlocks.length > 0) {
          const blockId = existingBlocks[0].id
          await run(`
            UPDATE node_block
            SET pm_json = '${escapeSql(JSON.stringify(pmJson))}',
                plain_text = '${escapeSql(plainText)}',
                updated_at = '${new Date().toISOString()}'
            WHERE id = '${blockId}'
          `)

          updateBlock(blockId, {
            pm_json: JSON.stringify(pmJson),
            plain_text: plainText,
            updated_at: new Date().toISOString(),
          })

          await updateAppearancesForBlock(nodeId, blockId, plainText)
        } else {
          const blockId = `block_${Date.now()}`
          const newBlock: ContentBlock = {
            id: blockId,
            node_id: nodeId,
            order_index: 0,
            pm_json: JSON.stringify(pmJson),
            plain_text: plainText,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }

          await run(`
            INSERT INTO node_block (id, node_id, order_index, pm_json, plain_text, created_at, updated_at)
            VALUES ('${blockId}', '${nodeId}', 0, '${escapeSql(JSON.stringify(pmJson))}', '${escapeSql(plainText)}', '${newBlock.created_at}', '${newBlock.updated_at}')
          `)

          addBlock(newBlock)
          await updateAppearancesForBlock(nodeId, blockId, plainText)
        }

        events.emit('editor:saved', { nodeId, content: plainText })
        events.emit('editor:block-updated', { blockId: existingBlocks[0]?.id || `block_${Date.now()}`, content: plainText })
      } catch (error) {
        console.error('Failed to save content:', error)
      }
    }, 800),
    [updateBlock, addBlock]
  )

  const loadNodeContent = useCallback(async (nodeId: string) => {
    try {
      const nodeRows = await query<StoryNode>(`SELECT * FROM story_node WHERE id='${nodeId}' LIMIT 1`)
      if (nodeRows[0]) {
        setNodeMeta(nodeRows[0])
        setTitle(nodeRows[0].title)
      }

      const nodeBlocks = await query<ContentBlock>(
        `SELECT * FROM node_block WHERE node_id = '${nodeId}' ORDER BY order_index`
      )

      if (nodeBlocks.length > 0) {
        const primaryBlock = nodeBlocks[0]
        try {
          const pmDoc = JSON.parse(primaryBlock.pm_json)
          editor?.commands.setContent(pmDoc)
        } catch {
          editor?.commands.setContent(`<p>${escapeHtml(primaryBlock.plain_text)}</p>`)
        }
      } else {
        editor?.commands.setContent('<p>开始书写你的故事…</p>')
      }

      setBlocks(nodeBlocks)
      setCurrentNodeId(nodeId)
    } catch (error) {
      console.error('Failed to load node content:', error)
    }
  }, [editor, setBlocks, setCurrentNodeId])

  const [nodeMeta, setNodeMeta] = useState<StoryNode | null>(null)
  const [title, setTitle] = useState('')
  const [activePanel, setActivePanel] = useState<PanelKey | null>(null)
  const formatPanelRef = useRef<HTMLDivElement | null>(null)

  const saveTitle = useMemo(
    () => debounce(async (nodeId: string, newTitle: string) => {
      try {
        await run(`UPDATE story_node SET title='${escapeSql(newTitle)}', updated_at='${new Date().toISOString()}' WHERE id='${nodeId}'`)
        events.emit('nodes:changed')
      } catch (e) {
        console.error('Failed to update title:', e)
      }
    }, 500),
    []
  )

  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== currentNodeId) {
      loadNodeContent(selectedNodeId)
    } else if (!selectedNodeId) {
      editor?.commands.setContent('<p>选择左侧章节开始写作...</p>')
      setCurrentNodeId(null)
      setNodeMeta(null)
      setTitle('')
    }
  }, [selectedNodeId, currentNodeId, loadNodeContent, editor, setCurrentNodeId])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (formatPanelRef.current && !formatPanelRef.current.contains(event.target as Node)) {
        setActivePanel((panel) => (panel === 'format' ? null : panel))
      }
    }
    if (activePanel === 'format') {
      document.addEventListener('mousedown', handleClick)
    }
    return () => document.removeEventListener('mousedown', handleClick)
  }, [activePanel])


  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '80px 48px',
        background: 'rgba(18,16,32,0.45)',
        backdropFilter: 'blur(16px)',
      }}
    >
      <button
        type="button"
        onClick={() => navigate('/graph')}
        style={{
          position: 'absolute',
          top: 32,
          left: 48,
          padding: '10px 18px',
          borderRadius: 999,
          border: 'none',
          background: '#ffffff',
          color: '#312a34',
          fontSize: 13,
          fontWeight: 600,
          boxShadow: '0 14px 32px rgba(22,18,46,0.22)',
          cursor: 'pointer',
        }}
      >
        ← 返回章节
      </button>

      <div
        style={{
          position: 'relative',
          width: 'min(960px, 100%)',
          minHeight: '70vh',
          borderRadius: 32,
          background: '#fdfcfe',
          boxShadow: '0 48px 120px rgba(20, 18, 40, 0.28)',
          padding: '40px 56px 48px 56px',
        }}
      >
        {nodeMeta ? (
          <>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                if (selectedNodeId) saveTitle(selectedNodeId, e.target.value)
              }}
              placeholder="未命名章节"
              style={{
                width: '100%',
                fontSize: 28,
                fontWeight: 700,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: '#2f2540',
              }}
            />
            <div style={{ fontSize: 13, color: '#847a97', marginTop: 8 }}>
              {nodeMeta.type} • {nodeMeta.status}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 14, color: '#7a708c' }}>请选择左侧章节后开始创作内容。</div>
        )}

      

        <div style={{ marginTop: 28, borderRadius: 26, background: '#ffffff', boxShadow: '0 30px 60px rgba(31, 26, 58, 0.12)', padding: '32px 38px', minHeight: 520 }}>
          <EditorContent
            editor={editor}
            style={{
              background: 'transparent',
              minHeight: 440,
            }}
          />
        </div>

        <div
          style={{
            position: 'absolute',
            top: 120,
            right: 40,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          
        </div>

        
      </div>
    </div>
  )
}






function escapeSql(s: string): string {
  return s.replaceAll("'", "''")
}

function escapeHtml(s: string): string {
  const el = document.createElement('div')
  el.textContent = s
  return el.innerHTML
}

