/**
 * AI API Service
 *
 * 调用后端 /api/ai 相关接口
 */

import axios from 'axios';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义
export interface SummarizeDto {
  text: string;
  maxLength?: number;
}

export interface ExtractElementsDto {
  text: string;
  elementTypes?: string[];
}

export interface FindPlotHolesDto {
  nodes: Array<{
    id: string;
    title: string;
    content: string;
  }>;
}

export interface GenerateSnippetDto {
  prompt: string;
  context?: string;
  maxTokens?: number;
}

export interface ImageToTextDto {
  imageUrl: string;
  prompt?: string;
}

export interface RewriteDto {
  text: string;
  style?: 'formal' | 'casual' | 'creative' | 'technical';
  instructions?: string;
}

export interface GenerateNamesDto {
  type: 'character' | 'place' | 'item';
  count?: number;
  context?: string;
}

export interface WorldBuildingDto {
  theme: string;
  aspects?: string[];
}

export interface DreamToStoryDto {
  dreamDescription: string;
  genre?: string;
}

/**
 * AI API 客户端
 */
export const aiApi = {
  /**
   * 文本摘要
   * POST /api/ai/summarize
   */
  async summarize(dto: SummarizeDto): Promise<{ summary: string }> {
    const response = await axios.post(`${BASE_URL}/api/ai/summarize`, dto);
    return response.data;
  },

  /**
   * 提取元素
   * POST /api/ai/extract-elements
   */
  async extractElements(dto: ExtractElementsDto): Promise<{ elements: unknown[] }> {
    const response = await axios.post(`${BASE_URL}/api/ai/extract-elements`, dto);
    return response.data;
  },

  /**
   * 查找情节漏洞
   * POST /api/ai/find-plot-holes
   */
  async findPlotHoles(dto: FindPlotHolesDto): Promise<{ plotHoles: unknown[] }> {
    const response = await axios.post(`${BASE_URL}/api/ai/find-plot-holes`, dto);
    return response.data;
  },

  /**
   * 生成文本片段
   * POST /api/ai/generate-snippet
   */
  async generateSnippet(dto: GenerateSnippetDto): Promise<{ text: string }> {
    const response = await axios.post(`${BASE_URL}/api/ai/generate-snippet`, dto);
    return response.data;
  },

  /**
   * 图片转文字
   * POST /api/ai/image-to-text
   */
  async imageToText(dto: ImageToTextDto): Promise<{ text: string }> {
    const response = await axios.post(`${BASE_URL}/api/ai/image-to-text`, dto);
    return response.data;
  },

  /**
   * 改写文本
   * POST /api/ai/rewrite
   */
  async rewrite(dto: RewriteDto): Promise<{ rewrittenText: string }> {
    const response = await axios.post(`${BASE_URL}/api/ai/rewrite`, dto);
    return response.data;
  },

  /**
   * 生成名字
   * POST /api/ai/generate-names
   */
  async generateNames(dto: GenerateNamesDto): Promise<{ names: string[] }> {
    const response = await axios.post(`${BASE_URL}/api/ai/generate-names`, dto);
    return response.data;
  },

  /**
   * 世界构建
   * POST /api/ai/world-building
   */
  async worldBuilding(dto: WorldBuildingDto): Promise<{ worldDetails: unknown }> {
    const response = await axios.post(`${BASE_URL}/api/ai/world-building`, dto);
    return response.data;
  },

  /**
   * 梦境转故事
   * POST /api/ai/dream-to-story
   */
  async dreamToStory(dto: DreamToStoryDto): Promise<{ story: string }> {
    const response = await axios.post(`${BASE_URL}/api/ai/dream-to-story`, dto);
    return response.data;
  },
};
