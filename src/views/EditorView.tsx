import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import { query, run } from '../lib/db';
import { debounce } from '../utils/debounce';
import { events } from '../lib/events';
import type { NodeBlock } from '../lib/schema';

export function EditorView() {
  const { 
    selectedNodeId, 
    currentNodeId,
    setCurrentNodeId,
    setBlocks,
    addBlock,
    updateBlock 
  } = useAppStore();

  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p>Select a node to edit its content...</p>',
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'prose prose-invert max-w-none focus:outline-none min-h-[400px] p-4'
      }
    },
    onUpdate: ({ editor }) => {
      const text = editor.getText();
      
      if (selectedNodeId && text.trim()) {
        saveContent(selectedNodeId, editor.getJSON(), text);
      }
    }
  });

  const saveContent = useCallback(
    debounce(async (nodeId: string, pmJson: Record<string, unknown>, plainText: string) => {
      try {
        const existingBlocks = await query<NodeBlock>(
          `SELECT * FROM node_block WHERE node_id = '${nodeId}' ORDER BY order_index`
        );

        if (existingBlocks.length > 0) {
          const blockId = existingBlocks[0].id;
          await run(`
            UPDATE node_block 
            SET pm_json = '${escapeSql(JSON.stringify(pmJson))}', 
                plain_text = '${escapeSql(plainText)}',
                updated_at = '${new Date().toISOString()}'
            WHERE id = '${blockId}'
          `);
          
          updateBlock(blockId, { 
            pm_json: JSON.stringify(pmJson), 
            plain_text: plainText,
            updated_at: new Date().toISOString()
          });
        } else {
          const blockId = `block_${Date.now()}`;
          const newBlock: NodeBlock = {
            id: blockId,
            node_id: nodeId,
            order_index: 0,
            pm_json: JSON.stringify(pmJson),
            plain_text: plainText,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          await run(`
            INSERT INTO node_block (id, node_id, order_index, pm_json, plain_text, created_at, updated_at)
            VALUES ('${blockId}', '${nodeId}', 0, '${escapeSql(JSON.stringify(pmJson))}', '${escapeSql(plainText)}', '${newBlock.created_at}', '${newBlock.updated_at}')
          `);

          addBlock(newBlock);
        }

        events.emit('editor:saved', { nodeId, content: plainText });
        events.emit('editor:block-updated', { blockId: existingBlocks[0]?.id || `block_${Date.now()}`, content: plainText });
        
        // Detect mentions for codex appearances
        const mentions = extractMentions(plainText);
        if (mentions.length > 0) {
          events.emit('editor:mention-detected', { blockId: existingBlocks[0]?.id || `block_${Date.now()}`, mentions });
        }
      } catch (error) {
        console.error('Failed to save content:', error);
      }
    }, 800),
    [updateBlock, addBlock]
  );

  const loadNodeContent = useCallback(async (nodeId: string) => {
    try {
      const nodeBlocks = await query<NodeBlock>(
        `SELECT * FROM node_block WHERE node_id = '${nodeId}' ORDER BY order_index`
      );

      if (nodeBlocks.length > 0) {
        const primaryBlock = nodeBlocks[0];
        try {
          const pmDoc = JSON.parse(primaryBlock.pm_json);
          editor?.commands.setContent(pmDoc);
        } catch {
          editor?.commands.setContent(`<p>${escapeHtml(primaryBlock.plain_text)}</p>`);
        }
      } else {
        editor?.commands.setContent('<p>Start writing...</p>');
      }

      setBlocks(nodeBlocks);
      setCurrentNodeId(nodeId);
    } catch (error) {
      console.error('Failed to load node content:', error);
    }
  }, [editor, setBlocks, setCurrentNodeId]);

  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== currentNodeId) {
      loadNodeContent(selectedNodeId);
    } else if (!selectedNodeId) {
      editor?.commands.setContent('<p>Select a node to edit its content...</p>');
      setCurrentNodeId(null);
    }
  }, [selectedNodeId, currentNodeId, loadNodeContent, editor, setCurrentNodeId]);

  function escapeSql(s: string): string {
    return s.replaceAll("'", "''");
  }

  function escapeHtml(s: string): string {
    const el = document.createElement('div');
    el.textContent = s;
    return el.innerHTML;
  }

  function extractMentions(text: string): string[] {
    const mentionRegex = /\[\[([^\]]+)\]\]|@(\w+)/g;
    const mentions: string[] = [];
    let match;
    
    while ((match = mentionRegex.exec(text)) !== null) {
      mentions.push(match[1] || match[2]);
    }
    
    return Array.from(new Set(mentions));
  }

  const currentNode = useAppStore(state => 
    state.nodes.find(node => node.id === selectedNodeId)
  );

  return (
    <div className="h-full flex flex-col">
      {currentNode && (
        <div className="border-b border-neutral-700 p-4">
          <h2 className="text-lg font-semibold">{currentNode.title}</h2>
          <div className="text-sm text-neutral-400 capitalize">
            {currentNode.type} • {currentNode.status}
          </div>
        </div>
      )}
      
      <div className="flex-1 overflow-auto">
        <EditorContent 
          editor={editor} 
          className="h-full"
        />
      </div>
    </div>
  );
}


