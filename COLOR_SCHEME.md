# Color Scheme

This project uses a centralized color scheme defined in Tailwind CSS configuration.

## Available Colors

### Card (淡黄色)
- **Value**: `rgba(254, 250, 224, 1)`
- **Purpose**: Card backgrounds, light yellow tint
- **Usage**: `bg-card`, `text-card`, `border-card`, etc.

### Button (淡褐色)
- **Value**: `rgba(227, 213, 202, 1)`
- **Purpose**: Button backgrounds, badges, light brown tint
- **Usage**: `bg-button`, `text-button`, `border-button`, etc.

### Mild (极淡黄色)
- **Value**: `rgba(254, 252, 245, 1)`
- **Purpose**: Very subtle backgrounds, off-white with warm tint
- **Usage**: `bg-mild`, `text-mild`, `border-mild`, etc.

## Configuration

Colors are defined in `tailwind.config.js`:

```javascript
theme: {
  extend: {
    colors: {
      'card': 'rgba(254, 250, 224, 1)',
      'button': 'rgba(227, 213, 202, 1)',
      'mild': 'rgba(254, 252, 245, 1)',
    },
  },
}
```

## Usage Examples

### Background
```tsx
<div className="bg-card">Card content</div>
<button className="bg-button">Submit</button>
<aside className="bg-mild">Sidebar</aside>
```

### Combined with inline styles
```tsx
<div
  className="bg-card"
  style={{
    padding: '14px 16px',
    borderRadius: 12,
  }}
>
  Content
</div>
```

### Dynamic classes
```tsx
const buttonClassName = (isActive: boolean) => 
  isActive ? 'bg-button' : 'bg-gray-100';

<button className={buttonClassName(true)}>Active</button>
```

## Files Modified

The following files have been updated to use Tailwind color classes:

1. `/frontend/src/App.tsx` - Left sidebar background
2. `/frontend/src/components/ElementPanel.tsx` - Create button, cards, badges, action buttons
3. `/frontend/src/views/Editor/EditorMenuBar.tsx` - Menu bar and format buttons
4. `/frontend/src/components/RightVerticalButtons.tsx` - Vertical action buttons

## Maintenance

- ✅ **DO**: Use Tailwind color classes (`bg-card`, `bg-button`, `bg-mild`)
- ❌ **DON'T**: Hardcode rgba values in components
- ✅ **DO**: Update `tailwind.config.js` to modify colors globally
- ❌ **DON'T**: Add custom CSS classes for these colors in `index.css`
