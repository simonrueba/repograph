import type { AriadneDB } from "../db";
import type { ProjectRecord } from "../types";

export class ProjectQueries {
  constructor(private db: AriadneDB) {}

  upsertProject(project: ProjectRecord): void {
    this.db
      .query(
        `INSERT INTO projects (project_id, root, language, last_index_ts)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id) DO UPDATE SET
           root          = excluded.root,
           language      = excluded.language,
           last_index_ts = excluded.last_index_ts`,
      )
      .run(project.project_id, project.root, project.language, project.last_index_ts);
  }

  getProject(projectId: string): ProjectRecord | null {
    return (
      (this.db
        .query(
          "SELECT project_id, root, language, last_index_ts FROM projects WHERE project_id = ?1",
        )
        .get(projectId) as ProjectRecord | null) ?? null
    );
  }

  getAllProjects(): ProjectRecord[] {
    return this.db
      .query("SELECT project_id, root, language, last_index_ts FROM projects")
      .all() as ProjectRecord[];
  }

  setProjectIndexTs(projectId: string, ts: number): void {
    this.db
      .query(
        `UPDATE projects SET last_index_ts = ?2 WHERE project_id = ?1`,
      )
      .run(projectId, ts);
  }

  /**
   * Find the project whose `root` is the longest prefix of `filePath`.
   * Returns the most specific (deepest) match, or null if none match.
   */
  getProjectForPath(filePath: string): ProjectRecord | null {
    const projects = this.getAllProjects();
    let best: ProjectRecord | null = null;
    let bestLen = -1;

    for (const project of projects) {
      const root = project.root.endsWith("/") ? project.root : project.root + "/";
      if (filePath.startsWith(root) || filePath === project.root) {
        if (project.root.length > bestLen) {
          bestLen = project.root.length;
          best = project;
        }
      }
    }

    return best;
  }
}
