import { v7 as uuidv7 } from 'uuid';

import { agentProviderAcceptsImages, agentProviderOption, isAgentProviderId } from './runtime/agent-provider-contract';
import type { AgentModelDriver, AgentModelImageInput } from './runtime/types';

/**
 * One vision request on behalf of a tool call: the session's own provider and
 * model look at material pictures and answer in text. The answer is the only
 * thing that returns to the conversation.
 */
const VISION_SYSTEM_PROMPT = [
  "You look at images from a novelist's research library for the writing Agent working in Drifting.",
  'Answer the question from what the images actually show. Transcribe visible text faithfully, including handwriting and captions; say plainly when something is illegible or absent.',
  'Do not invent details, and do not give writing advice unless the question asks for it.',
  "Answer in the language of the question.",
].join(' ');

const VISION_MAX_OUTPUT_TOKENS = 4_000;

export interface MaterialVisionRequest {
  provider: string | null;
  model: string | null;
  sessionId: string;
  question: string;
  context: string;
  images: readonly AgentModelImageInput[];
  signal: AbortSignal;
}

export async function askMaterialVision(driver: AgentModelDriver, request: MaterialVisionRequest): Promise<string> {
  if (!request.provider || !isAgentProviderId(request.provider) || !agentProviderAcceptsImages(request.provider)) {
    const label = request.provider && isAgentProviderId(request.provider) ? agentProviderOption(request.provider).label : '当前模型';
    throw new Error(`${label} 不能看图；作者把对话换成 Claude 或 GPT 系列模型后再试`);
  }
  if (request.images.length === 0) throw new Error('这个素材没有可查看的画面');
  const turnId = uuidv7();
  let answer = '';
  for await (const event of driver.stream({
    sessionId: `material-vision:${request.sessionId}`,
    turnId,
    iteration: 1,
    lifecycle: 'single_request',
    provider: request.provider,
    ...(request.model ? { model: request.model } : {}),
    context: {
      systemPrompt: VISION_SYSTEM_PROMPT,
      messages: [
        {
          type: 'model_message',
          sourceIds: [`material-vision:${turnId}`],
          message: { role: 'user', content: `${request.context}\n\n${request.question}`, images: request.images },
        },
      ],
    },
    tools: [],
    maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
    signal: request.signal,
  })) {
    if (event.type === 'text_delta') answer += event.text;
  }
  const trimmed = answer.trim();
  if (!trimmed) throw new Error('模型没有返回对画面的描述');
  return trimmed;
}
