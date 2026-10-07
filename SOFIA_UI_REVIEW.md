# Sofia App UI/UX Review

## Executive Summary

The Sofia app has a well-architected, modern UI with thoughtful component design. However, there are opportunities to improve clarity, consistency, and user guidance across several key interaction areas. This review covers session UI, composer attachments, annotations, file mentions, thinking blocks, and overall UX patterns.

---

## 1. **Session UI & Overall Layout**

### Current Implementation
- Clean, focused layout with sidebar, message list, and collapsible panels
- Dark theme with subtle color gradients
- Sticky composer at bottom with sticky scroll position
- Top rail with session controls, status, and settings

### ✅ Strengths
- Minimalist design keeps focus on content
- Good use of whitespace and visual hierarchy
- Responsive layout adapts well to screen sizes
- Session notices bubble important warnings to top

### ⚠️ Areas for Improvement

1. **Session Status Visibility**
   - Current status indicator could be more prominent (especially for errors)
   - No clear "session paused" or "waiting for input" state visual
   - Warning banner at top is good, but could use better icon/color contrast

2. **Message Flow Clarity**
   - User messages (light background) vs. assistant messages (plain) creates adequate separation
   - Could benefit from timeline/turn indicators on left gutter
   - Long sessions become hard to navigate; consider persistent turn/timestamp navigation

3. **Empty States**
   - Initial "Ask Sofia" hero is good but could show recent sessions or quick-start templates
   - Empty panels (right sidebar) show placeholder text but lack visual guidance on what to do next

### 🎯 Recommendations
- Add subtle turn/step counter on left margin (`Turn 1 → Turn 2 → ...`)
- Improve session status indicator (add icon, test with various states)
- Add keyboard shortcuts overlay (Cmd+K or `?`) to show navigation tips
- Show micro-context: "Sofia is thinking..." vs. "Waiting for you" vs. "Error occurred"

---

## 2. **Composer Attachment Handling**

### Current Implementation
```tsx
// Editor shows inline attachment chips
<span className="data-attachment-id">
  [image preview or icon] [filename] [remove button]
</span>

// Supports drag-drop, paste, and file picker
// Shows upload spinner during send
```

### ✅ Strengths
- Drag-drop upload experience is smooth
- Image previews in composer provide confidence
- File type icons (document, image, folder) are clear
- Upload progress visual feedback (spinner overlay)
- Graceful handling of multiple attachments with wrapping layout

### ⚠️ Areas for Improvement

1. **Attachment Feedback & Errors**
   - No clear indication if upload fails or gets cut off
   - Error states aren't visually distinct from "ready" state
   - No file size warnings before upload
   - Disabled state message (`attachmentsDisabledReason`) is hidden until hover

2. **Attachment Organization**
   - All attachments render inline; no grouping or sorting
   - No indicator of total size being uploaded
   - Can't reorder or prioritize attachments
   - No "expand all previews" / "collapse all" for many files

3. **Attachment Context**
   - `annotationContext` field exists in type but is never displayed
   - Users don't know *why* a file was attached or what context applies
   - No way to add per-file annotations or notes

4. **Mobile/Compact View**
   - Attachment chips wrap but may not scale well on small screens
   - Thumbnail size is fixed; could be context-aware

### 🎯 Recommendations
```tsx
// 1. Show disabled state proactively
<div role="alert" className="text-sm text-amber-10">
  ⚠️ Attachments unavailable: {attachmentsDisabledReason}
</div>

// 2. Add file metadata with upload progress
<div className="flex items-center justify-between text-xs text-gray-10">
  <span>{filename} • {formatBytes(size)}</span>
  {uploading && <ProgressBar value={uploadProgress} />}
</div>

// 3. Reorderable attachment list (drag handles)
<Sortable items={attachments} onReorder={setAttachments}>
  {attachment => <AttachmentChip key={attachment.id} {...attachment} />}
</Sortable>

// 4. Per-file annotation (optional)
<div className="text-xs text-gray-10 mt-1">
  📝 {attachment.annotationContext || "No context"}
</div>
```

---

## 3. **File Mention Handling**

### Current Implementation
```tsx
// Mention encoding: @file_path or @agent_name
// Pill-styled rendering with kind-specific colors
const MENTION_PILL_CLASS = {
  file: "border-gray-6 bg-gray-3",      // neutral gray
  agent: "border-sky-6/35 bg-sky-3/20", // blue
  app: "border-cyan-6/35 bg-cyan-3/20"  // cyan
}

// Smart menu shows files, agents, apps with icons
// Fuzzy search + keyboard nav
```

### ✅ Strengths
- Visual distinction between mention types (file = gray, agent = blue, app = cyan)
- Mention menu is fast and keyboard-friendly
- Icons provide quick visual reference (file, folder, lightning bolt, app window)
- Encoded mention values prevent space/special character issues
- File paths show type (Folder vs. File) in tooltip

### ⚠️ Areas for Improvement

1. **Mention Clarity**
   - File mentions show truncated path but full path only in title attribute
   - No breadcrumb or hierarchy visualization for nested file paths
   - Folder mentions (`@path/`) look identical to file mentions until hover
   - User doesn't know if mention resolved correctly after inserting

2. **Mention Context**
   - No preview of what the mentioned file contains
   - Large/binary files mentioned with no warning
   - File mention doesn't show file size or modification time
   - No indication if file is inside .gitignore or filtered

3. **Mention Menu UX**
   - Menu closes when user scrolls message history (can lose context)
   - Recent mentions not tracked; always requires search
   - No distinction between "recently mentioned" vs. "frequently mentioned"
   - Keyboard arrow keys nav through menu, but no visual indicator of selection

4. **Agent Mentions**
   - Limited info shown about available agents
   - No way to see agent status (active, idle, error)
   - Computer Use app mentions only shown if Computer Use extension enabled (not obvious why missing)

### 🎯 Recommendations
```tsx
// 1. Enhanced file mention pill
<span className="mention-pill file">
  <FileIcon /> Documents/
  <span className="opacity-70 text-xs ml-1">3 files • 2.4 MB</span>
</span>

// 2. File mention preview on hover
<Popover>
  <PopoverTrigger asChild>
    <span className="mention-pill">{mention}</span>
  </PopoverTrigger>
  <PopoverContent className="w-64 text-sm">
    <div>📄 README.md</div>
    <div className="text-xs text-gray-10 mt-1">
      {fileSize} • Modified {timeAgo}
    </div>
    <div className="mt-2 max-h-32 overflow-auto text-xs bg-gray-2 p-2 rounded">
      {preview}
    </div>
  </PopoverContent>
</Popover>

// 3. Visual confirmation after insertion
<Toast type="success">
  ✓ Added file mention: Documents/README.md
</Toast>

// 4. Mention history
<div className="text-xs text-gray-10 mt-3">
  Recent: @task.md, @config.json
</div>
```

---

## 4. **Annotation Handling**

### Current Implementation
```tsx
// Annotations stored alongside attachments
export type ComposerAttachment = {
  id: string;
  annotationContext?: string;  // Optional field, rarely used
}

// No explicit annotation UI in composer
```

### ✅ Strengths
- Type system prepared for annotations (`annotationContext` field exists)
- Doesn't clutter UI with unused features

### ⚠️ Areas for Improvement

1. **Feature Discovery**
   - Annotation capability exists in types but has zero UI
   - Users have no way to know they can add context to attachments
   - No documentation visible in composer

2. **Annotation Display**
   - If annotations exist, they're never shown to the user before send
   - No way to edit/update annotations after adding file
   - Annotations don't carry through to the message history
   - Users can't see what context was sent with a file

3. **Use Case Clarity**
   - Unclear when/why to use annotations vs. just mentioning file in prompt
   - No examples or guidance

### 🎯 Recommendations
```tsx
// 1. Add annotation input in attachment chip
<div className="flex flex-col gap-1">
  <div className="flex items-center justify-between">
    <span className="text-sm">{attachment.name}</span>
    <button onClick={() => setAnnotating(attachment.id)}>
      <Edit2Icon size={14} />
    </button>
  </div>
  {annotating === attachment.id ? (
    <input
      type="text"
      placeholder="e.g., 'Focus on error handling'"
      value={annotation}
      onChange={(e) => setAttachmentAnnotation(attachment.id, e.target.value)}
      onBlur={() => setAnnotating(null)}
      autoFocus
      className="text-xs bg-gray-2 rounded px-2 py-1"
    />
  ) : annotation ? (
    <div className="text-xs text-gray-10">💭 {annotation}</div>
  ) : null}
</div>

// 2. Show annotations in sent message
<div className="text-xs text-gray-10 mt-1">
  {attachment.annotationContext && `📝 Context: ${attachment.annotationContext}`}
</div>

// 3. Add help text
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild>
      <button className="text-xs text-gray-10">
        Add context <HelpCircle size={12} />
      </button>
    </TooltipTrigger>
    <TooltipContent>
      Add context to help Sofia understand how to use this file
    </TooltipContent>
  </Tooltip>
</TooltipProvider>
```

---

## 5. **Thinking Blocks (Reasoning Display)**

### Current Implementation
```tsx
export function ReasoningBlock({ text, isStreaming, defaultOpen = false }) {
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>
        <span>{isStreaming ? "Thinking…" : "Thought"}</span>
        <ChevronDown className="group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <MessageContent markdown>
          {text}
        </MessageContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
```

### ✅ Strengths
- Collapsed by default keeps interface clean
- "Thinking…" indicator while streaming provides good feedback
- Switches to "Thought" when complete (subtle state change)
- Chevron rotation shows open/close state clearly
- Can be expanded on demand without cluttering transcript
- Markdown rendering within thoughts is consistent

### ⚠️ Areas for Improvement

1. **Visual Distinction**
   - No icon to distinguish thinking blocks from regular text
   - Color (muted-foreground) blends in; could be more distinct
   - No left border or visual indicator of block type
   - Collapsed thinking blocks take minimal space but look like they could be clickable section headers

2. **Thinking Block Content**
   - Long thinking text renders as plain markdown; no syntax highlighting
   - Code blocks in thinking aren't styled differently from prose
   - No visual indicator of thinking "depth" or complexity
   - Nested reasoning structures (thoughts about thoughts) render flat

3. **State Management**
   - Manual toggle survives until phase ends (good), but user has no way to reset
   - No "auto-expand latest thinking" option
   - If model generates multiple thinking blocks per turn, they all collapse independently (UX unclear)

4. **Analytics & Feedback**
   - No way to provide feedback on thought quality
   - No "copy just the thinking" functionality
   - Thinking visibility not tracked (for user preferences)

5. **Accessibility**
   - No ARIA labels on chevron
   - Collapsible semantic role is correct but "Thinking…" label could be clearer

### 🎯 Recommendations
```tsx
export function ReasoningBlock({ text, isStreaming, defaultOpen = false }) {
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-l-2 border-amber-6 pl-3">
      <CollapsibleTrigger className="group flex items-center gap-2 text-sm hover:text-foreground">
        <Sparkles size={14} className="text-amber-10" />
        <span className="font-medium">
          {isStreaming ? "Thinking…" : "Thought"}
        </span>
        <span className="text-xs text-gray-10">
          ({wordCount} {wordCount === 1 ? 'word' : 'words'})
        </span>
        <ChevronDown size={14} className="ml-auto transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="rounded-lg bg-gray-2 p-3">
          <MessageContent markdown className="text-sm">
            {text}
          </MessageContent>
        </div>
        <div className="flex gap-2 mt-2 text-xs">
          <button onClick={() => copyToClipboard(text)} className="text-gray-11 hover:text-gray-12">
            📋 Copy thinking
          </button>
          <button onClick={() => shareThinking(text)} className="text-gray-11 hover:text-gray-12">
            🔗 Share
          </button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Visual enhancements
// 1. Thinking block container with subtle background
.reasoning-block {
  border-left: 2px solid var(--amber-6);
  padding-left: 0.75rem;
  background: color-mix(in srgb, var(--amber-3) 5%, transparent);
}

// 2. Syntax highlighting in code blocks
.reasoning-block pre code {
  background: var(--gray-2);
  border-radius: 4px;
  padding: 0.5rem;
}

// 3. Thinking phase indicator
.reasoning-streaming::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--amber-10);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}
```

---

## 6. **Overall UI/UX Patterns & Consistency**

### Current Implementation
- **Color System**: DLS (Design Language System) with semantic color names (`dls-surface`, `dls-border`, `dls-accent`)
- **Typography**: Consistent font scale with semantic sizes
- **Components**: Modular React components with TypeScript
- **Layout**: Flexbox-based, responsive with Tailwind utilities

### ✅ Strengths
- Consistent component API across similar widgets
- Good error toast placement and messaging
- Keyboard navigation works well in menus
- Dark theme is easy on the eyes
- Proper use of semantic HTML and ARIA labels

### ⚠️ Areas for Improvement

1. **Visual Feedback & Confirmation**
   - Success states are subtle (sometimes just a checkmark)
   - Destructive actions (e.g., clearing draft, removing mention) don't confirm
   - Attachment removal is immediate; could show undo toast
   - No visual "reaction" when sending a message (brief flash or highlight)

2. **Loading States**
   - Multiple spinners used inconsistently (LoaderCircle in some places, CSS animation elsewhere)
   - No skeleton screens for content areas (e.g., file list while loading)
   - Long operations don't show time estimates or progress
   - Tool execution feedback is hidden in message; unclear if agent is working or stuck

3. **Error Messaging**
   - Some errors show in toast, others inline
   - No consistent error code reference for debugging
   - Network error handling not visible (auto-retry or give up?)
   - File attachment errors (e.g., too large, unsupported) could be proactive

4. **Hover & Interactive States**
   - Message actions hide until hover; doesn't work well on mobile
   - Mention pills should show more info on hover (current: just tooltip)
   - Attachment chips show remove button inline (good), but could have hover state
   - No hover states for some interactive elements (e.g., turn timestamps)

5. **Touch & Accessibility**
   - Context menus work on desktop; mobile users tap open/share instead
   - No haptic feedback on mobile for attachment removal
   - Font sizes might be too small on mobile (test 320px breakpoint)
   - Text selection in messages works but not obvious (no visual highlight style)

6. **Animation & Motion**
   - Collapsible transitions are smooth
   - Message list scrolls but no fade at edges
   - Mention menu fades in/out (good)
   - Could use micro-interactions for attachment upload confirmation

### 🎯 Recommendations

```tsx
// 1. Undo toast for destructive actions
const removeAttachment = (id: string) => {
  const removed = attachments.find(a => a.id === id);
  setAttachments(prev => prev.filter(a => a.id !== id));
  
  toast.success("Attachment removed", {
    action: {
      label: "Undo",
      onClick: () => {
        setAttachments(prev => [...prev, removed]);
      }
    }
  });
}

// 2. Unified loading state component
<LoadingState 
  variant="spinner" 
  message="Uploading…" 
  progress={65}
  eta="~2s remaining"
/>

// 3. Consistent error pattern
<ErrorAlert 
  message="File too large (5MB max)"
  code="ATTACHMENT_SIZE_EXCEEDED"
  action={{ label: "Learn more", href: "/docs/attachments" }}
/>

// 4. Mobile-friendly message actions
const MessageActions = ({ message }) => {
  const [open, setOpen] = useState(false);
  
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">⋯</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Copy</DropdownMenuItem>
        <DropdownMenuItem>Branch</DropdownMenuItem>
        <DropdownMenuItem>Revert</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 5. Micro-interaction on attachment success
@keyframes attachmentSuccess {
  0% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
}

[data-attachment-status="ready"] {
  animation: attachmentSuccess 0.4s ease-out;
}
```

---

## 7. **Cross-Cutting Concerns**

### Accessibility
- ✅ Good: Semantic HTML, ARIA labels on buttons, keyboard navigation
- ⚠️ Needs: Focus indicators on all interactive elements, color contrast check, screen reader testing
- 🎯 Action: Run WCAG 2.1 AA audit; add `:focus-visible` to all interactive elements

### Mobile Responsiveness
- ✅ Good: Responsive layout, touch-friendly button sizes
- ⚠️ Needs: Text size check at 320px; mobile context menus; file attachments on small screens
- 🎯 Action: Test on iPhone 12 mini; verify Attachment UI at 375px viewport

### Performance
- ✅ Good: Lazy loading of images, memoized components
- ⚠️ Needs: Virtual scrolling for long message lists (1000+ messages?); chunk thinking blocks
- 🎯 Action: Profile with 500+ messages; consider windowing for performance

### Keyboard Shortcuts
- ✅ Good: Cmd+Enter to send, Arrow keys in menus
- ⚠️ Needs: Discoverable shortcuts (show `?` help), consistent across features
- 🎯 Action: Add `?` key handler; display shortcuts modal

---

## 8. **Quick Wins (High-Impact, Low-Effort)**

| Priority | Issue | Fix |
|----------|-------|-----|
| 🔴 High | Thinking blocks lack visual distinction | Add left border + icon (sparkles) + background |
| 🔴 High | Attachment errors not visible | Show inline alert when disabled or upload fails |
| 🟡 Medium | File mentions no preview | Add hover popover with file summary |
| 🟡 Medium | Message actions hidden on mobile | Use `DropdownMenu` instead of hover reveal |
| 🟡 Medium | Annotation feature invisible | Add small edit button + inline input |
| 🟢 Low | No copy thinking block action | Add "Copy thinking" button in reasoning footer |
| 🟢 Low | Mention history not tracked | Show recent mentions in menu |
| 🟢 Low | Attach menu closes on scroll | Pin menu with portal; close on explicit dismiss |

---

## 9. **Proposed UI Enhancements Summary**

### Phase 1 (Next Sprint)
1. **Thinking Blocks**: Add icon, left border, background color, copy button
2. **Attachment Errors**: Show inline alert when disabled
3. **File Mentions**: Add preview popover on hover

### Phase 2 (Following Sprint)
1. **Annotations**: Add inline edit UI for annotation context
2. **Message Actions**: Convert hover-reveal to menu for mobile
3. **Mobile Testing**: Verify at 320px–400px viewports

### Phase 3 (Future)
1. **Session Timeline**: Add turn/step indicators on left margin
2. **Advanced Features**: Attachment reordering, mention history tracking
3. **Accessibility Audit**: WCAG 2.1 AA compliance pass

---

## Conclusion

The Sofia app has a solid, modern foundation with thoughtful interaction design. The main opportunities are:

1. **Clarity**: Make invisible features visible (annotations, thinking context)
2. **Consistency**: Unify error handling, loading states, and mobile interactions
3. **Delight**: Add micro-interactions and visual feedback for key actions
4. **Accessibility**: Ensure keyboard/screen reader parity with visual UI

Focus on **Phase 1** quick wins first—thinking blocks and attachment feedback—then move to **Phase 2** mobile improvements.

