/**
 * 统一导出所有 API 服务
 * 
 * 这些服务对应后端的 REST API，用于替代 SQLite 本地存储
 */

// API 客户端和工具
export { apiClient, tokenManager, handleApiError } from '../lib/api';

// 认证服务
export { authService } from './auth.service';
export type { User, LoginInput, RegisterInput, AuthResponse } from './auth.service';

// 用户服务
export { userService } from './user.service';
export type { UpdateUserInput } from './user.service';

// 项目服务
export { projectService } from './project.service';
export type { Project, CreateProjectInput, UpdateProjectInput } from './project.service';

// 节点服务
export { nodeService, nodeEdgeService } from './node.service';
export type { BookNodeCreateData, BookNodeUpdateData, BookNodeEdge } from './node.service';

// 故事线服务
export { storylineService } from './storyline.service';
export type { CreateStorylineInput, UpdateStorylineInput } from './storyline.service';

// 元素服务
export { elementService, elementCategoryService } from './element.service';

// 内容服务
export { contentService } from './content.service';

// 阶段和标签服务
export { stageService, nodeTagService } from './stage.service';
