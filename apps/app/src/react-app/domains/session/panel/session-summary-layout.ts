import { placeComputerPreview, type PreviewRect } from "./computer-preview-layout";

/** Keep the default live preview below the summary when that lane fits. */
export function avoidSessionSummary(point:{x:number;y:number},size:{width:number;height:number},host:{width:number;height:number},obstacles:PreviewRect[]) {
  let next=point;
  for(const rect of obstacles) {
    const overlaps=next.x<rect.x+rect.width+12 && next.x+size.width>rect.x-12 && next.y<rect.y+rect.height+12 && next.y+size.height>rect.y-12;
    if(!overlaps)continue;
    const y=rect.y+rect.height+12;
    if(y+size.height<=host.height-24)next={x:next.x,y};
    else return placeComputerPreview(size,host,obstacles,null);
  }
  return next;
}
