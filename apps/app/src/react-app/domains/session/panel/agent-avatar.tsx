/** Original Sofia vector marks. Identity, rather than list position, selects the mark. */
export function agentAvatarIdentity(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return { shape: hash % 6, palette: (hash >>> 8) % 8 };
}

const palettes = [
  ["#73CFF2", "#287FAD"], ["#A991EE", "#6950B7"],
  ["#F1AA72", "#BA6540"], ["#8FD2A6", "#428967"],
  ["#EC8DAD", "#AE486E"], ["#EDCB6E", "#A18530"],
  ["#76D8CD", "#338E88"], ["#99B9F5", "#526FBB"],
];

export function AgentAvatar({ id, className = "size-5" }: { id: string; className?: string }) {
  const { shape, palette } = agentAvatarIdentity(id);
  const [light, dark] = palettes[palette];
  return <svg data-agent-avatar={id} data-avatar-shape={shape} data-avatar-palette={palette} className={`${className} shrink-0`} viewBox="0 0 24 24" aria-hidden="true">
    {shape === 0 ? <>{[0, 90, 180, 270].map(angle => <path key={angle} transform={`rotate(${angle} 12 12)`} fill={light} d="M12 11C4 11 3 4 8 3c5-1 5 4 4 8Z"/>)}<circle cx="12" cy="12" r="3" fill={dark}/></> : null}
    {shape === 1 ? <>{[0, 60, 120, 180, 240, 300].map(angle => <ellipse key={angle} transform={`rotate(${angle} 12 12)`} cx="12" cy="6.5" rx="3" ry="5" fill={angle % 120 === 0 ? light : dark}/>)}<circle cx="12" cy="12" r="3" fill={light}/></> : null}
    {shape === 2 ? <>{[0, 90, 180, 270].map(angle => <path key={angle} transform={`rotate(${angle} 12 12)`} fill={angle % 180 === 0 ? light : dark} d="m12 2 9 10-9-2Z"/>)}<circle cx="12" cy="12" r="2" fill={light}/></> : null}
    {shape === 3 ? <><path fill={dark} d="m12 1 5 6 6 5-6 5-5 6-5-6-6-5 6-5Z"/><path fill={light} d="m12 5 3 7-3 7-3-7Zm-7 7 7-3 7 3-7 3Z"/></> : null}
    {shape === 4 ? <>{[0, 120, 240].map(angle => <path key={angle} transform={`rotate(${angle} 12 12)`} fill={light} d="M12 12C0 13 1 2 8 2c5 0 8 7 4 10Z"/>)}<circle cx="12" cy="12" r="3.5" fill={dark}/></> : null}
    {shape === 5 ? <><circle cx="12" cy="12" r="10" fill="none" stroke={dark} strokeWidth="3"/>{[0, 120, 240].map(angle => <circle key={angle} transform={`rotate(${angle} 12 12)`} cx="12" cy="5" r="4" fill={light}/>)}<circle cx="12" cy="12" r="3" fill={dark}/></> : null}
  </svg>;
}
