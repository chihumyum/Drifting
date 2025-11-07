import apiClient, { handleApiError } from '../lib/api';
import type { BookElement, BookElementCategory } from '../domain/book_element';

/**
 * 元素服务 - 对应后端 /elements API
 */
export const elementService = {
  /**
   * 根据 ID 获取元素
   */
  async findById(id: string): Promise<BookElement | null> {
    try {
      const response = await apiClient.get<BookElement>(`/elements/${id}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch element:', handleApiError(error));
      return null;
    }
  },

  /**
   * 获取所有元素（可按项目、分类、标签过滤）
   */
  async findAll(filters?: {
    projectId?: string;
    category?: string;
    tag?: string;
  }): Promise<BookElement[]> {
    try {
      const response = await apiClient.get<BookElement[]>('/elements', {
        params: filters,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch elements:', handleApiError(error));
      return [];
    }
  },

  /**
   * 根据项目获取所有元素
   */
  async findAllByProject(projectId: string): Promise<BookElement[]> {
    return this.findAll({ projectId });
  },

  /**
   * 根据项目和分类获取元素
   */
  async findAllByCategory(projectId: string, category: string): Promise<BookElement[]> {
    return this.findAll({ projectId, category });
  },

  /**
   * 根据项目和标签获取元素
   */
  async findAllByTag(projectId: string, tag: string): Promise<BookElement[]> {
    return this.findAll({ projectId, tag });
  },

  /**
   * 创建新元素
   */
  async create(element: BookElement): Promise<BookElement> {
    try {
      const response = await apiClient.post<BookElement>('/elements', element);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create element: ${handleApiError(error)}`);
    }
  },

  /**
   * 更新元素
   */
  async update(id: string, element: Partial<BookElement>): Promise<BookElement | null> {
    try {
      const response = await apiClient.patch<BookElement>(`/elements/${id}`, element);
      return response.data;
    } catch (error) {
      console.error('Failed to update element:', handleApiError(error));
      return null;
    }
  },

  /**
   * 删除元素
   */
  async delete(id: string): Promise<boolean> {
    try {
      await apiClient.delete(`/elements/${id}`);
      return true;
    } catch (error) {
      console.error('Failed to delete element:', handleApiError(error));
      return false;
    }
  },

  /**
   * 设置元素分类
   */
  async setElementCategory(elementId: string, categoryName: string): Promise<void> {
    try {
      await apiClient.put(`/elements/${elementId}/category`, { category: categoryName });
    } catch (error) {
      throw new Error(`Failed to set element category: ${handleApiError(error)}`);
    }
  },

  /**
   * 获取元素分类
   */
  async getElementCategory(elementId: string): Promise<string | null> {
    try {
      const response = await apiClient.get<{ category: string }>(`/elements/${elementId}/category`);
      return response.data.category;
    } catch (error) {
      console.error('Failed to get element category:', handleApiError(error));
      return null;
    }
  },

  /**
   * 更新元素分类（别名，同 setElementCategory）
   */
  async updateElementCategory(elementId: string, categoryName: string): Promise<void> {
    return this.setElementCategory(elementId, categoryName);
  },

  /**
   * 获取元素标签
   */
  async getElementTags(elementId: string): Promise<string[]> {
    try {
      const response = await apiClient.get<string[]>(`/elements/${elementId}/tags`);
      return response.data;
    } catch (error) {
      console.error('Failed to get element tags:', handleApiError(error));
      return [];
    }
  },

  /**
   * 添加元素标签
   */
  async addElementTag(elementId: string, tag: string): Promise<void> {
    try {
      await apiClient.post(`/elements/${elementId}/tags/${tag}`);
    } catch (error) {
      throw new Error(`Failed to add element tag: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除元素标签
   */
  async removeElementTag(elementId: string, tag: string): Promise<void> {
    try {
      await apiClient.delete(`/elements/${elementId}/tags/${tag}`);
    } catch (error) {
      throw new Error(`Failed to remove element tag: ${handleApiError(error)}`);
    }
  },

  /**
   * 设置元素的所有标签
   */
  async setElementTags(elementId: string, tags: string[]): Promise<void> {
    try {
      await apiClient.put(`/elements/${elementId}/tags`, { tags });
    } catch (error) {
      throw new Error(`Failed to set element tags: ${handleApiError(error)}`);
    }
  },

  /**
   * 获取元素内容
   */
  async getElementContent(elementId: string): Promise<string> {
    try {
      const response = await apiClient.get<{ content: string }>(`/elements/${elementId}/content`);
      return response.data.content || '{}';
    } catch (error) {
      console.error('Failed to get element content:', handleApiError(error));
      return '{}';
    }
  },

  /**
   * 设置元素内容
   */
  async setElementContent(elementId: string, content: string): Promise<void> {
    try {
      await apiClient.put(`/elements/${elementId}/content`, { content });
    } catch (error) {
      throw new Error(`Failed to set element content: ${handleApiError(error)}`);
    }
  },
};

/**
 * 元素分类服务 - 对应后端 /elements/categories API
 */
export const elementCategoryService = {
  /**
   * 获取所有分类
   */
  async findAll(): Promise<BookElementCategory[]> {
    try {
      const response = await apiClient.get<BookElementCategory[]>('/elements/categories');
      return response.data;
    } catch (error) {
      console.error('Failed to fetch categories:', handleApiError(error));
      return [];
    }
  },

  /**
   * 根据名称获取分类
   */
  async findByName(name: string): Promise<BookElementCategory | null> {
    try {
      const response = await apiClient.get<BookElementCategory>(`/elements/categories/${name}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch category:', handleApiError(error));
      return null;
    }
  },

  /**
   * 创建新分类
   */
  async create(name: string, color?: string): Promise<BookElementCategory> {
    try {
      const response = await apiClient.post<BookElementCategory>('/elements/categories', {
        name,
        color,
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create category: ${handleApiError(error)}`);
    }
  },

  /**
   * 更新分类
   */
  async update(
    name: string,
    updates: { color?: string; description_json?: string }
  ): Promise<BookElementCategory | null> {
    try {
      const response = await apiClient.patch<BookElementCategory>(
        `/elements/categories/${name}`,
        updates
      );
      return response.data;
    } catch (error) {
      console.error('Failed to update category:', handleApiError(error));
      return null;
    }
  },

  /**
   * 删除分类
   */
  async delete(name: string): Promise<boolean> {
    try {
      await apiClient.delete(`/elements/categories/${name}`);
      return true;
    } catch (error) {
      console.error('Failed to delete category:', handleApiError(error));
      return false;
    }
  },

  /**
   * 确保分类存在（如果不存在则创建）
   * TODO: 后端需要实现这个 API
   */
  async ensureCategory(name: string): Promise<void> {
    try {
      await apiClient.post('/elements/categories/ensure', { name });
    } catch (error) {
      throw new Error(`Failed to ensure category: ${handleApiError(error)}`);
    }
  },
};
