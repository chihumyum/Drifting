import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject } from '../usecase/useProject';
import { useStoryline } from '../usecase/useStoryline';
import { Project } from '../domain/project';
import { initDatabase } from '../lib/db';
import loglevel from 'loglevel';

const log = loglevel.getLogger("ProjectHomeView");
// log.setLevel(loglevel.levels.ERROR);
log.setLevel(loglevel.levels.DEBUG);

export function ProjectHomeView() {
    const navigate = useNavigate();
    const { loadProjects, createProject } = useProject();
    const { createStoryline } = useStoryline();
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newProjectName, setNewProjectName] = useState('');
    const [showCreateModal, setShowCreateModal] = useState(false);

    useEffect(() => {
        const init = async () => {
            try {
                await initDatabase();
                await fetchProjects();
            } catch (e) {
                log.error("Failed to init projects view", e);
            } finally {
                setLoading(false);
            }
        };
        init();
    }, [loadProjects]);

    const fetchProjects = async () => {
        const data = await loadProjects();
        log.debug("Loaded projects:", data);
        setProjects(data);
    };

    const handleCreateProject = async () => {
        if (isCreating) return;
        setIsCreating(true);

        try {
            // 1. Create Project
            const name = newProjectName.trim() || 'Untitled Project';
            const project = await createProject({
                projectName: name,
                author: 'User',
                description: '',
            });

            // 2. Create Default Storyline
            await createStoryline({
                projectId: project.id,
                name: 'Main Storyline',
                summary: 'The main storyline of the project.',
                color: '#FF5733',
            });

            // 3. Navigate
            navigate(`/project/${project.id}`);
        } catch (error) {
            log.error('Failed to create project:', error);
            setIsCreating(false);
        }
    };

    if (loading) {
        return (
            <div style={styles.container}>
                <div style={styles.loadingText}>Loading Projects...</div>
            </div>
        );
    }

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={styles.title}>Drifting</h1>
                <p style={styles.subtitle}>Select a project to continue or start a new journey.</p>
            </div>

            <div style={styles.grid}>
                {/* Create New Card */}
                <div
                    style={{ ...styles.card, ...styles.createCard }}
                    onClick={() => setShowCreateModal(true)}
                >
                    <div style={styles.plusIcon}>+</div>
                    <div style={styles.createText}>Create New Project</div>
                </div>

                {/* Project List */}
                {projects.map((project) => (
                    <div
                        key={project.id}
                        style={styles.card}
                        onClick={() => navigate(`/project/${project.id}`)}
                    >
                        <h3 style={styles.projectName}>{project.name}</h3>
                        <p style={styles.projectAuthor}>by {project.author}</p>
                        <div style={styles.cardFooter}>
                            <span style={styles.date}>
                                {project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : ''}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Simple Modal for Creation */}
            {showCreateModal && (
                <div style={styles.modalOverlay}>
                    <div style={styles.modalContent}>
                        <h2 style={styles.modalTitle}>New Project</h2>
                        <input
                            autoFocus
                            style={styles.input}
                            placeholder="Project Name"
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCreateProject();
                                if (e.key === 'Escape') setShowCreateModal(false);
                            }}
                        />
                        <div style={styles.modalActions}>
                            <button
                                style={styles.cancelButton}
                                onClick={() => setShowCreateModal(false)}
                            >
                                Cancel
                            </button>
                            <button
                                style={styles.createButton}
                                onClick={handleCreateProject}
                                disabled={isCreating}
                            >
                                {isCreating ? 'Creating...' : 'Create Project'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        height: '100vh',
        width: '100vw',
        backgroundColor: '#1E1E1E', // Dark background
        color: '#E0E0E0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '40px',
        boxSizing: 'border-box',
        overflowY: 'auto',
    },
    header: {
        marginBottom: '40px',
        textAlign: 'center',
    },
    title: {
        fontSize: '3rem',
        fontWeight: '700',
        margin: '0 0 10px 0',
        color: '#FFFFFF',
        letterSpacing: '-1px',
    },
    subtitle: {
        fontSize: '1.1rem',
        color: '#AAAAAA',
        margin: 0,
    },
    loadingText: {
        fontSize: '1.5rem',
        color: '#888',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
        gap: '20px',
        width: '100%',
        maxWidth: '1200px',
    },
    card: {
        backgroundColor: '#2C2C2C',
        borderRadius: '12px',
        padding: '24px',
        cursor: 'pointer',
        transition: 'transform 0.2s, box-shadow 0.2s',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: '160px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
    },
    createCard: {
        border: '2px dashed #444',
        backgroundColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#888',
    },
    plusIcon: {
        fontSize: '3rem',
        fontWeight: '300',
        marginBottom: '10px',
    },
    createText: {
        fontSize: '1.1rem',
        fontWeight: '500',
    },
    projectName: {
        fontSize: '1.4rem',
        margin: '0 0 8px 0',
        color: '#FFF',
        fontWeight: '600',
        wordBreak: 'break-word',
    },
    projectAuthor: {
        fontSize: '0.9rem',
        color: '#888',
        margin: 0,
    },
    cardFooter: {
        marginTop: '20px',
        fontSize: '0.8rem',
        color: '#666',
        textAlign: 'right',
    },
    modalOverlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(5px)',
    },
    modalContent: {
        backgroundColor: '#252525',
        padding: '30px',
        borderRadius: '16px',
        width: '400px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #333',
    },
    modalTitle: {
        marginTop: 0,
        marginBottom: '20px',
        color: '#FFF',
        fontSize: '1.5rem',
    },
    input: {
        padding: '12px 16px',
        fontSize: '1rem',
        borderRadius: '8px',
        border: '1px solid #444',
        backgroundColor: '#1A1A1A',
        color: '#FFF',
        marginBottom: '24px',
        outline: 'none',
    },
    modalActions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '12px',
    },
    cancelButton: {
        padding: '10px 20px',
        borderRadius: '8px',
        border: '1px solid #444',
        backgroundColor: 'transparent',
        color: '#CCC',
        fontSize: '0.9rem',
        cursor: 'pointer',
        transition: 'background-color 0.2s',
    },
    createButton: {
        padding: '10px 20px',
        borderRadius: '8px',
        border: 'none',
        backgroundColor: '#D4AF37', // Gold/Accent color
        color: '#111',
        fontWeight: '600',
        fontSize: '0.9rem',
        cursor: 'pointer',
        transition: 'opacity 0.2s',
    },
};
