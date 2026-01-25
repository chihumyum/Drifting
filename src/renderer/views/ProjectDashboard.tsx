import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { useStoryline } from '../usecase/useStoryline';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { Plus, BookOpen, Layers, FileText, ChevronRight } from 'lucide-react';
import loglevel from 'loglevel';

const log = loglevel.getLogger("ProjectDashboard");

export function ProjectDashboard() {
    const navigate = useNavigate();
    const { projectId } = useProjectNavigation();
    const userId = useAuthStore((state) => state.user?.id);
    const { storylines, bookElements, bookElementCategories } = useDataStore();

    const { createStoryline } = useStoryline({
        projectId: projectId ?? '',
        userId: userId ?? '',
    });

    // Calculate statistics
    const stats = useMemo(() => {
        return {
            storylines: storylines.length,
            elements: bookElements.length,
            categories: bookElementCategories.length,
        };
    }, [storylines, bookElements, bookElementCategories]);

    const handleCreateStoryline = async () => {
        try {
            const newStoryline = await createStoryline({
                name: 'Untitled Storyline',
                summary: '',
            });
            navigate(`../editor/storyline/${newStoryline.id}`);
        } catch (e) {
            log.error('Failed to create storyline', e);
        }
    };

    return (
        <div className="h-full w-full flex flex-col p-8 overflow-y-auto bg-[#F9F9F9]">
            <header className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Dashboard</h1>
                <p className="text-gray-500">Overview of your project progress.</p>
            </header>

            {/* Statistics Section */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">Storylines</p>
                        <p className="text-3xl font-bold text-gray-800 mt-1">{stats.storylines}</p>
                    </div>
                    <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
                        <BookOpen size={24} />
                    </div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">Elements</p>
                        <p className="text-3xl font-bold text-gray-800 mt-1">{stats.elements}</p>
                    </div>
                    <div className="p-3 bg-green-50 text-green-600 rounded-lg">
                        <FileText size={24} />
                    </div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">Categories</p>
                        <p className="text-3xl font-bold text-gray-800 mt-1">{stats.categories}</p>
                    </div>
                    <div className="p-3 bg-purple-50 text-purple-600 rounded-lg">
                        <Layers size={24} />
                    </div>
                </div>
            </div>

            {/* Storylines Section */}
            <section className="mb-10">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                        <BookOpen size={20} className="text-blue-500" />
                        Storylines
                    </h2>
                    <button
                        onClick={handleCreateStoryline}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition duration-200"
                    >
                        <Plus size={16} />
                        New Storyline
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {storylines.map((sl) => (
                        <div
                            key={sl.id}
                            onClick={() => navigate(`../editor/storyline/${sl.id}`)}
                            className="group bg-white rounded-xl shadow-sm hover:shadow-md border border-gray-100 hover:border-blue-200 transition-all duration-200 cursor-pointer overflow-hidden flex flex-col h-48"
                        >
                            <div
                                className="h-2 w-full"
                                style={{ backgroundColor: sl.color || '#3B82F6' }}
                            />
                            <div className="p-5 flex-1 flex flex-col">
                                <h3 className="text-lg font-bold text-gray-800 mb-2 group-hover:text-blue-600 transition-colors line-clamp-2">
                                    {sl.name || 'Untitled Storyline'}
                                </h3>
                                <p className="text-sm text-gray-500 line-clamp-3 mb-4 flex-1">
                                    {sl.summary || 'No summary provided.'}
                                </p>
                                <div className="flex items-center justify-between text-xs text-gray-400 mt-auto">
                                    <span>{new Date(sl.updatedAt).toLocaleDateString()}</span>
                                    <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity -translate-x-2 group-hover:translate-x-0" />
                                </div>
                            </div>
                        </div>
                    ))}

                    {/* New Storyline Card (Quick Action) */}
                    <div
                        onClick={handleCreateStoryline}
                        className="border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center h-48 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all group"
                    >
                        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 group-hover:bg-blue-100 group-hover:text-blue-500 mb-3 transition-colors">
                            <Plus size={24} />
                        </div>
                        <span className="text-sm font-medium text-gray-500 group-hover:text-blue-600">Create New Storyline</span>
                    </div>
                </div>
            </section>

            {/* Categories Section */}
            <section>
                <div className="flex items-center gap-2 mb-4">
                    <Layers size={20} className="text-purple-500" />
                    <h2 className="text-xl font-bold text-gray-800">Element Categories</h2>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    <div
                        onClick={() => navigate('../editor/all-nodes')} // Navigating to all elements panel equivalent or just create
                        className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 hover:shadow-md hover:border-purple-200 cursor-pointer transition-all flex items-center gap-3"
                    >
                        <div className="w-3 h-3 rounded-full bg-gray-400"></div>
                        <span className="text-sm font-medium text-gray-700">All Elements</span>
                    </div>

                    {bookElementCategories.map((cat) => (
                        <div
                            key={cat.id}
                            onClick={() => navigate(`../category/${encodeURIComponent(cat.name)}`)}
                            className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 hover:shadow-md hover:border-purple-200 cursor-pointer transition-all flex items-center gap-3"
                        >
                            <div
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: cat.color || '#A855F7' }}
                            />
                            <span className="text-sm font-medium text-gray-700 truncate">{cat.name}</span>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
