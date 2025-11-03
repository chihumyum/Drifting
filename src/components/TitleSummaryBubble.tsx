import { useState, useEffect } from 'react';

interface TitleSummaryBubbleProps {
  title: string;
  summary: string;
}

export function TitleSummaryBubble({ title, summary }: TitleSummaryBubbleProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [summaryHeight, setSummaryHeight] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      // Find the title element in the editor
      const titleElement = document.querySelector('[data-title-header]');
      if (!titleElement) return;

      const rect = titleElement.getBoundingClientRect();
      // Show bubble when title is scrolled out of view (above viewport)
      setIsVisible(rect.bottom < 0);
    };

    // Check on mount and scroll
    handleScroll();
    
    const scrollContainer = document.querySelector('[data-editor-scroll]');
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
    
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Measure summary height when it changes
  useEffect(() => {
    if (!summary) {
      setSummaryHeight(0);
      return;
    }

    // Create a temporary element to measure summary height
    const tempDiv = document.createElement('div');
    tempDiv.style.position = 'absolute';
    tempDiv.style.visibility = 'hidden';
    tempDiv.style.width = '328px'; // Match the expanded summary width
    tempDiv.style.fontSize = '13px';
    tempDiv.style.lineHeight = '1.6';
    tempDiv.style.padding = '0';
    tempDiv.style.margin = '0';
    tempDiv.textContent = summary;
    
    document.body.appendChild(tempDiv);
    const height = tempDiv.offsetHeight;
    document.body.removeChild(tempDiv);
    
    setSummaryHeight(height);
  }, [summary]);

  if (!isVisible) return null;

  const bubbleStyle = {
    background: 'rgba(255, 255, 255, 0.98)',
    borderRadius: 12,
    padding: isExpanded ? '12px 16px' : '8px 14px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.05)',
    backdropFilter: 'blur(12px)',
    cursor: 'pointer',
    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', // Smooth easing without bounce
    maxWidth: isExpanded ? 360 : 'none', // Max width when expanded
    minWidth: 'fit-content',
  };

  const titleContainerStyle = {
    overflow: 'hidden',
    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
  };

  const titleStyle = {
    fontSize: 14,
    fontWeight: 600,
    color: '#2d2438',
    margin: 0,
    whiteSpace: 'nowrap' as const,
  };

  const summaryContainerStyle = {
    overflow: 'hidden',
    transition: 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), margin 0.4s cubic-bezier(0.4, 0, 0.2, 1), width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
    maxHeight: isExpanded ? summaryHeight + 20 : 0,
    marginTop: isExpanded ? 8 : 0,
    width: isExpanded ? 328 : 0, // Fixed width (360 - 32px padding) when expanded, 0 when collapsed
  };

  const summaryStyle = {
    fontSize: 13,
    fontWeight: 400,
    color: '#6b5e7f',
    margin: 0,
    lineHeight: 1.6,
    opacity: isExpanded ? 1 : 0,
    transform: isExpanded ? 'translateY(0)' : 'translateY(-8px)',
    transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1) 0.25s, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1) 0.25s', // Delay 0.25s, so it appears near the end
    whiteSpace: 'normal' as const,
    wordBreak: 'break-word' as const,
  };

  return (
    <div
      style={bubbleStyle}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div style={titleContainerStyle}>
        <div style={titleStyle}>{title || 'Untitled Chapter'}</div>
      </div>
      {summary && (
        <div style={summaryContainerStyle}>
          <div style={summaryStyle}>{summary}</div>
        </div>
      )}
    </div>
  );
}
