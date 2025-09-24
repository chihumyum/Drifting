function VerticalToolbarButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  active?: boolean
  onClick: () => void
}) {
  const buttonStyle: CSSProperties = {
    width: 52,
    height: 52,
    borderRadius: 20,
    border: 'none',
    background: active ? '#4c7df3' : '#f0edf8',
    color: active ? '#ffffff' : '#554a70',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: active ? '0 14px 28px rgba(76,125,243,0.35)' : '0 8px 20px rgba(52, 44, 70, 0.18)',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease',
  }
  return (
    <button
      type="button"
      style={buttonStyle}
      onClick={onClick}
      onMouseEnter={(event) => {
        (event.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={(event) => {
        (event.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'
      }}
      title={label}
    >
      <Icon size={20} />
    </button>
  )
}


export const RightVerticalButtons = () => {
    return <div>

        <VerticalToolbarButton
                    icon={TypeIcon}
                    label="Format"
                    active={activePanel === 'format'}
                    onClick={() => setActivePanel((prev) => (prev === 'format' ? null : 'format'))}
                  />
                  <VerticalToolbarButton
                    icon={Info}
                    label="Info"
                    active={activePanel === 'info'}
                    onClick={() => setActivePanel((prev) => (prev === 'info' ? null : 'info'))}
                  />
                  <VerticalToolbarButton
                    icon={LayoutDashboard}
                    label="Page"
                    active={activePanel === 'page'}
                    onClick={() => setActivePanel((prev) => (prev === 'page' ? null : 'page'))}
                  />
                  <VerticalToolbarButton
                    icon={Stars}
                    label="Inspire"
                    active={false}
                    onClick={() => alert('未来将提供灵感功能')}
                  />
                  <VerticalToolbarButton
                    icon={Palette}
                    label="Theme"
                    active={false}
                    onClick={() => alert('未来将提供主题切换功能')}
                  />
                  <VerticalToolbarButton
                    icon={Eye}
                    label="Inspector"
                    active={activePanel === 'inspector'}
                    onClick={() => setActivePanel((prev) => (prev === 'inspector' ? null : 'inspector'))}
                  />
                  <VerticalToolbarButton
                    icon={CheckSquare}
                    label="TODO"
                    active={activePanel === 'todo'}
                    onClick={() => setActivePanel((prev) => (prev === 'todo' ? null : 'todo'))}
                  />
                  <VerticalToolbarButton
                    icon={Scissors}
                    label="Snippets"
                    active={activePanel === 'snippets'}
                    onClick={() => setActivePanel((prev) => (prev === 'snippets' ? null : 'snippets'))}
                  />
    </div>
}