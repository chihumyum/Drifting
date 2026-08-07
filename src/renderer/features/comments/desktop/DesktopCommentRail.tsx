import type { ComponentProps } from 'react';
import { CommentRail } from '../../../components/editor/CommentRail';

type DesktopCommentRailProps = ComponentProps<typeof CommentRail>;

/** Desktop block-anchored geometry around shared comment data and card behavior. */
export function DesktopCommentRail(props: DesktopCommentRailProps) {
  return <CommentRail {...props} />;
}
