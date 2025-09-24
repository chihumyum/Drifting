
import type { Editor } from '@tiptap/core'
import type { CSSProperties, ComponentType, Ref, FC } from 'react'

// Floating Panel Right
interface FloatingPanelProps {
    onStart?: () => void // bind editor 
    onClose: () => void // 
    anchorRight: number
}

interface FormatPanelProps extends FloatingPanelProps {
    panelRef: Ref<HTMLDivElement>
    editor: Editor
    applyHeading: (level: 1 | 2 | 3) => void
    applyParagraph: () => void
    toggleBold: () => void
    toggleItalic: () => void
    toggleUnderline: () => void
    toggleBulletList: () => void
    toggleOrderedList: () => void
    toggleBlockquote: () => void
    toggleCodeBlock: () => void
}

function FormatPanel({
    panelRef,
    anchorRight,
    editor,
    onClose,
    applyHeading,
    applyParagraph,
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleBulletList,
    toggleOrderedList,
    toggleBlockquote,
    toggleCodeBlock,
}: FormatPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 120,
        width: 300,
        borderRadius: 24,
        background: 'rgba(255,255,255,0.96)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        border: '1px solid rgba(228,222,241,0.8)',
        zIndex: 40,
    }

    const sectionLabelStyle: CSSProperties = {
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: '#8b82a0',
    }

    const chipStyle = (active?: boolean): CSSProperties => ({
        padding: '8px 12px',
        borderRadius: 12,
        border: 'none',
        background: active ? '#4c7df3' : '#f1eefc',
        color: active ? '#ffffff' : '#413655',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: active ? '0 10px 24px rgba(76,125,243,0.32)' : 'none',
    })

    const isActive = (name: string, attrs?: Record<string, unknown>) => editor?.isActive(name, attrs) ?? false

    return (
        <div ref={panelRef} style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 16, color: '#322845' }}>Format</h4>
                <button
                    type="button"
                    onClick={onClose}
                    style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}
                >
                    ×
                </button>
            </div>

            <div>
                <div style={sectionLabelStyle}>Titles</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button type="button" style={chipStyle(isActive('heading', { level: 1 }))} onClick={() => applyHeading(1)}>Title</button>
                    <button type="button" style={chipStyle(isActive('heading', { level: 2 }))} onClick={() => applyHeading(2)}>Subtitle</button>
                    <button type="button" style={chipStyle(isActive('heading', { level: 3 }))} onClick={() => applyHeading(3)}>Heading</button>
                </div>
            </div>

            <div>
                <div style={sectionLabelStyle}>Content</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button type="button" style={chipStyle(isActive('paragraph'))} onClick={applyParagraph}>Body</button>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Caption placeholder')}>Caption</button>
                </div>
            </div>

            <div>
                <div style={sectionLabelStyle}>Groups</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Page placeholder')}>Page</button>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Card placeholder')}>Card</button>
                </div>
            </div>

            <div>
                <div style={sectionLabelStyle}>Styles</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 10 }}>
                    <button type="button" style={chipStyle(isActive('bold'))} onClick={toggleBold}>B</button>
                    <button type="button" style={chipStyle(isActive('italic'))} onClick={toggleItalic}>I</button>
                    <button type="button" style={chipStyle(isActive('underline'))} onClick={toggleUnderline}>U</button>
                    <button type="button" style={chipStyle(isActive('codeBlock'))} onClick={toggleCodeBlock}>&lt;/&gt;</button>
                    <button type="button" style={chipStyle(isActive('bulletList'))} onClick={toggleBulletList}>• List</button>
                    <button type="button" style={chipStyle(isActive('orderedList'))} onClick={toggleOrderedList}>1. List</button>
                    <button type="button" style={chipStyle(isActive('blockquote'))} onClick={toggleBlockquote}>Quote</button>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Checklist placeholder')}>Checklist</button>
                </div>
            </div>

            <div>
                <div style={sectionLabelStyle}>Decorations</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Focus placeholder')}>Focus</button>
                    <button type="button" style={chipStyle(false)} onClick={() => alert('Block placeholder')}>Block</button>
                </div>
            </div>
        </div>
    )
}

function InfoPanel({ onClose, anchorRight }: FloatingPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 220,
        width: 280,
        borderRadius: 22,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        border: '1px solid rgba(230,224,238,0.8)',
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    }
    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 15, color: '#322845' }}>Info</h4>
                <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}>×</button>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#6d607d' }}>章节元数据、统计信息与 AI 建议将在此处展示。</p>
            <p style={{ margin: 0, fontSize: 12, color: '#6d607d' }}>当前版本为占位内容。</p>
        </div>
    )
}

function LayoutPanel({ onClose, anchorRight }: FloatingPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 340,
        width: 280,
        borderRadius: 22,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        border: '1px solid rgba(230,224,238,0.8)',
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    }
    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 15, color: '#322845' }}>Page Layout</h4>
                <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}>×</button>
            </div>
            <button
                type="button"
                style={{
                    padding: '10px 14px',
                    borderRadius: 14,
                    border: 'none',
                    background: '#f0edf8',
                    color: '#4a3d62',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                }}
                onClick={() => alert('页面布局功能尚未实现')}
            >
                页面模板
            </button>
            <button
                type="button"
                style={{
                    padding: '10px 14px',
                    borderRadius: 14,
                    border: 'none',
                    background: '#f0edf8',
                    color: '#4a3d62',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                }}
                onClick={() => alert('页面拆分占位')}
            >
                切换页面布局
            </button>
        </div>
    )
}

function InspectorPanel({ onClose, anchorRight }: FloatingPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 220,
        width: 280,
        borderRadius: 22,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        border: '1px solid rgba(230,224,238,0.8)',
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    }
    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 15, color: '#322845' }}>Inspector</h4>
                <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}>×</button>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#6d607d' }}>章节关联的实体、节点状态与统计数据将汇总于此。</p>
            <p style={{ margin: 0, fontSize: 12, color: '#6d607d' }}>当前为占位面板。</p>
        </div>
    )
}

function TodoPanel({ onClose, anchorRight }: FloatingPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 340,
        width: 280,
        borderRadius: 22,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        border: '1px solid rgba(230,224,238,0.8)',
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
    }
    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 15, color: '#322845' }}>TODO</h4>
                <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#6d607d' }}>在此记录章节待办、重写片段或校对事项。</div>
            <div style={{
                borderRadius: 14,
                background: '#f4f1fe',
                padding: '12px 14px',
                color: '#645a87',
                fontSize: 12,
                boxShadow: 'inset 0 0 0 1px rgba(122,114,160,0.15)',
            }}>
                • 示例：补足场景对白，强化人物动机
            </div>
            <div style={{
                borderRadius: 14,
                background: '#f4f1fe',
                padding: '12px 14px',
                color: '#645a87',
                fontSize: 12,
                boxShadow: 'inset 0 0 0 1px rgba(122,114,160,0.15)',
            }}>
                • 示例：检查时间线是否与上一章一致
            </div>
        </div>
    )
}

function SnippetsPanel({ onClose, anchorRight }: FloatingPanelProps) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        right: anchorRight,
        top: 460,
        width: 280,
        borderRadius: 22,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 28px 60px rgba(25, 18, 63, 0.2)',
        padding: '20px 22px',
        border: '1px solid rgba(230,224,238,0.8)',
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
    }
    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 15, color: '#322845' }}>Snippets</h4>
                <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8a7fa5', cursor: 'pointer' }}>×</button>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#6d607d' }}>保存可复用的段落、对白或设定描述。下方展示示例。</p>
            <div style={{
                borderRadius: 14,
                background: '#fff9f0',
                padding: '12px 14px',
                color: '#7c5f38',
                fontSize: 12,
                boxShadow: 'inset 0 0 0 1px rgba(196,152,87,0.2)',
            }}>
                “她端起温热的茶杯，像是握住了最后一段连接现实的绳索。”
            </div>
        </div>
    )
}
