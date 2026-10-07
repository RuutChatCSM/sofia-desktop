# Thinking Block UI Design Guide

## Visual Comparison

### ❌ Current (Before)
```
┌─────────────────────────────────────┐
│ Thought  ❯                          │  ← Minimal, no icon
└─────────────────────────────────────┘    Blends into interface
                                            No visual hierarchy
```

### ✅ Improved (After)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ✨ Thinking…    387 words     ❯   ┃  ← Sparkles icon
┃                                   ┃    Word count shown
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ The architecture layers consist of:┃  ← Expanded content
┃                                   ┃
┃ 1. Presentation (React/TS)        ┃
┃ 2. Logic (State + Rules)          ┃
┃                                   ┃
┃ [📋 Copy thinking] [🔗 Share]    ┃  ← Action buttons
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
└─ Amber left border                    Visual distinction
   Subtle background fill                Clear affordance
```

---

## Design Specifications

### Color Scheme

| Element | Color | Opacity | Usage |
|---------|-------|---------|-------|
| Left Border | `#db7852` | 70% | Primary accent, 2px width |
| Container Bg | `#db7852` | 8% | Subtle background fill |
| Container Border | `#db7852` | 20% | Container outline, 1px |
| Text | `#e0e0e0` | 100% | Primary text label |
| Secondary Text | `#888` | 100% | Word count, hints |

### Dimensions

```
Trigger (Collapsed):
├─ Height: 50px
├─ Padding: 14px 16px
├─ Gap between items: 10px
└─ Border radius: 12px (container)

Content (Expanded):
├─ Padding: 16px
├─ Code box: 14px padding
├─ Gap to buttons: 14px
└─ Border-top: 1px @ 12% opacity

Buttons:
├─ Padding: 6px 12px
├─ Font: 12px, weight 500
├─ Border radius: 6px
└─ Gap: 10px between buttons
```

### Typography

```
Label Text:        "Thinking…"  (14px, weight 500)
Status Indicator:  "387 words"  (12px, weight 400, muted)
Content Text:      13px, line-height 1.6
Code/Technical:    12px monospace, line-height 1.6
Button Text:       12px, weight 500
```

### Styling Details

#### Container
```css
background: linear-gradient(135deg, rgba(180, 130, 71, 0.08) 0%, rgba(180, 130, 71, 0.04) 100%);
border: 1px solid rgba(180, 130, 71, 0.2);
border-left: 2px solid rgba(219, 120, 82, 0.7);
border-radius: 12px;
overflow: hidden;
```

#### Trigger (Collapsed/Expanded State)
```css
/* Default */
display: flex;
align-items: center;
gap: 10px;
padding: 14px 16px;
cursor: pointer;
font-size: 14px;
font-weight: 500;
color: #e0e0e0;
transition: background-color 0.15s;

/* Hover */
background: rgba(180, 130, 71, 0.15);

/* Expanded */
border-bottom: 1px solid rgba(180, 130, 71, 0.12);
```

#### Content Area
```css
display: block;  /* toggle with open state */
padding: 16px;
border-top: 1px solid rgba(180, 130, 71, 0.12);
background: transparent;
```

#### Code Content Box
```css
background: rgba(0, 0, 0, 0.4);
border-radius: 8px;
padding: 14px;
font-size: 13px;
line-height: 1.6;
color: #bbb;
font-family: 'Menlo', 'Monaco', monospace;
margin-bottom: 14px;
```

#### Action Buttons
```css
/* Base */
font-size: 12px;
padding: 6px 12px;
border: 1px solid rgba(255, 255, 255, 0.1);
background: rgba(255, 255, 255, 0.05);
color: #aaa;
border-radius: 6px;
cursor: pointer;
transition: all 0.15s;
font-weight: 500;

/* Hover */
background: rgba(255, 255, 255, 0.1);
color: #fff;
border-color: rgba(255, 255, 255, 0.15);
```

---

## Implementation

### React Component Example

```tsx
import { Sparkles, ChevronDown, Copy, Share2 } from "lucide-react"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"

export function ReasoningBlock({ text, isStreaming, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const wordCount = text.split(/\s+/).length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-l-2 border-amber-6 pl-3">
      <CollapsibleTrigger className="group flex items-center gap-2.5 text-sm font-medium hover:bg-amber-3/10 px-4 py-3.5 rounded-lg transition-colors">
        <Sparkles size={16} className="text-amber-10" />
        <span>
          {isStreaming ? "Thinking…" : "Thought"}
        </span>
        <span className="text-xs text-gray-11 ml-auto">
          {wordCount} {wordCount === 1 ? 'word' : 'words'}
        </span>
        <ChevronDown 
          size={14} 
          className="transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      
      <CollapsibleContent className="mt-2 pl-4 pr-3">
        <div className="rounded-lg bg-gray-2 p-3.5 mb-3">
          <MessageContent 
            markdown 
            className="text-sm text-gray-12"
          >
            {text}
          </MessageContent>
        </div>
        
        <div className="flex gap-2.5">
          <button 
            onClick={() => copyToClipboard(text)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-gray-3 hover:bg-gray-4 text-gray-11 transition-colors"
          >
            <Copy size={12} />
            Copy thinking
          </button>
          <button 
            onClick={() => shareThinking(text)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-gray-3 hover:bg-gray-4 text-gray-11 transition-colors"
          >
            <Share2 size={12} />
            Share
          </button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
```

### CSS Enhancement

```css
/* Thinking block container */
[data-reasoning-block] {
  border-left: 2px solid var(--amber-6);
  padding-left: 0.75rem;
  background: color-mix(in srgb, var(--amber-3) 5%, transparent);
  border-radius: 12px;
  overflow: hidden;
}

/* Trigger state */
[data-reasoning-block] [role="button"] {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--gray-12);
  transition: background-color 0.15s ease-out;
}

[data-reasoning-block] [role="button"]:hover {
  background: color-mix(in srgb, var(--amber-3) 15%, transparent);
}

/* Expanded state */
[data-reasoning-block][data-state="open"] [role="button"] {
  border-bottom: 1px solid color-mix(in srgb, var(--amber-6) 12%, transparent);
}

/* Chevron rotation */
[data-reasoning-block] [role="button"] svg:last-child {
  transition: transform 0.2s ease-out;
}

[data-reasoning-block][data-state="open"] [role="button"] svg:last-child {
  transform: rotate(180deg);
}

/* Content styling */
[data-reasoning-block] [role="region"] {
  padding: 1rem;
  border-top: 1px solid color-mix(in srgb, var(--amber-6) 12%, transparent);
}

/* Code in thinking blocks */
[data-reasoning-block] pre {
  background: color-mix(in srgb, var(--gray-2) 60%, transparent);
  border-radius: 0.5rem;
  padding: 1rem;
  overflow-x: auto;
}

[data-reasoning-block] code {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
}

/* Streaming pulse animation */
[data-reasoning-block].streaming::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--amber-10);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
  margin-right: 0.5rem;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

---

## States & Interactions

### 1. **Collapsed (Idle)**
```
┌──────────────────────────────────────┐
│ ✨ Thought    387 words      ❯       │  ← User sees summary
└──────────────────────────────────────┘    Can expand to read
```

### 2. **Expanding (Animation)**
```
┌──────────────────────────────────────┐
│ ✨ Thinking…  387 words      ❯       │  ← Height animates
├──────────────────────────────────────┤    Content fades in
│ [content appears with opacity fade]  │
└──────────────────────────────────────┘
```

### 3. **Expanded (Streaming)**
```
┌──────────────────────────────────────┐
│ ✨ Thinking…  387 words      ❯       │  ← Live pulse animation
├──────────────────────────────────────┤    on sparkles icon
│ "The system architecture..."         │
│                                      │
│ [📋 Copy thinking] [🔗 Share]       │
└──────────────────────────────────────┘
```

### 4. **Expanded (Complete)**
```
┌──────────────────────────────────────┐
│ ✨ Thought    387 words      ❱       │  ← "Thinking…" → "Thought"
├──────────────────────────────────────┤
│ "The system architecture..."         │
│                                      │
│ [📋 Copy thinking] [🔗 Share]       │
└──────────────────────────────────────┘
```

### 5. **Hover States**
- **Trigger hover**: Subtle background tint (amber at 15%)
- **Button hover**: Brighter background, slightly lighter text
- **Chevron hover**: No change (part of trigger)

---

## Accessibility Improvements

### ARIA Labels
```tsx
<button 
  role="button"
  aria-label="Expand thinking block"
  aria-expanded={open}
  aria-controls="thinking-content-123"
>
  {/* ... */}
</button>
```

### Focus States
```css
[role="button"]:focus-visible {
  outline: 2px solid var(--amber-10);
  outline-offset: 2px;
}
```

### Screen Reader Support
- "Thinking block, 387 words, collapsed. Press enter to expand."
- When expanded: "Thinking block expanded. [Content]. Copy thinking button. Share button."

---

## Migration Path

### Phase 1: Visual Updates (Low Risk)
1. Add amber left border (2px)
2. Add sparkles icon from lucide-react
3. Add word count indicator
4. Update background fill

### Phase 2: Interactions (Medium Risk)
1. Add "Copy thinking" button
2. Add "Share" button
3. Update hover states
4. Add CSS animations

### Phase 3: Polish (Low Risk)
1. Add ARIA labels for accessibility
2. Add focus indicators
3. Add keyboard shortcuts (Cmd+C while expanded)
4. Add analytics tracking

---

## Browser Support

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Mobile browsers (iOS 14+, Android Chrome 90+)

---

## Testing Checklist

- [ ] Collapsed state renders correctly
- [ ] Click trigger expands/collapses content
- [ ] Keyboard navigation (Tab, Enter, Escape)
- [ ] Hover states work smoothly
- [ ] Copy button copies exact text
- [ ] Share button opens share dialog
- [ ] Word count updates with content
- [ ] Streaming "Thinking…" state shows animation
- [ ] Mobile: Touch targets >= 44px
- [ ] Mobile: No hover state issues
- [ ] Accessibility: Screen reader reads all content
- [ ] Dark mode: Colors render correctly
- [ ] Performance: No layout shift on expand

