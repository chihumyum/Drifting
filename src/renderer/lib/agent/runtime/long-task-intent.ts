/**
 * Authors commonly describe a long project campaign through desired outcomes
 * instead of naming it a "long task". This detector only decides whether the
 * durable task tools should be visible; it does not constrain the targets or
 * require the model to use a plan.
 */
export function isBroadAutonomousProjectCampaign(request: string): boolean {
  const broadScope =
    /(?:这|本|整|当前)?(?:本书|小说|作品|项目)|(?:前|后|上|下)半(?:本|部|段)?|开头(?:这)?(?:一)?部分|现有(?:章节|资料|人物|关系)/iu.test(
      request,
    ) ||
    /(?:这|该|上述|以下|这批|这一组|这组).{0,16}(?:人物|角色|要素)(?:档案|资料|关系)?/u.test(
      request,
    ) ||
    /\b(?:this|the|current) (?:book|novel|manuscript|project)|\b(?:first|second) half\b/iu.test(
      request,
    );
  if (!broadScope) return false;

  const chineseWorkSignals = request.match(
    /整理|收拾|补(?:齐|全|起来)?|清(?:理|掉)|删(?:除|掉)?|去重|理顺|处理|修(?:复|订)|改(?:写|动)|创(?:建|作)|新建|推进|续写|收尾|复(?:核|查)|检查/giu,
  );
  const englishWorkSignals = request.match(
    /\b(?:organize|complete|fill|clean|delete|deduplicate|reconcile|fix|revise|edit|create|advance|continue writing|finish|review|verify)\b/giu,
  );
  const workSignalCount =
    (chineseWorkSignals?.length ?? 0) + (englishWorkSignals?.length ?? 0);
  if (workSignalCount < 2) return false;

  return (
    /自己(?:查|看|判断|决定|处理)|从头复核|只要还有|没收完|继续做|做到(?:完成|收完)|直到(?:完成|收完)/iu.test(
      request,
    ) ||
    /\b(?:decide for yourself|work autonomously|review from (?:the )?start|keep going|continue until|until (?:it is )?(?:done|complete))\b/iu.test(
      request,
    )
  );
}
