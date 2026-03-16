//! Organisation and Agent-template types for the Channel-Agent admin UI.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A top-level organisation that groups one or more Agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
    /// Unique identifier (UUID v4).
    pub id: Uuid,
    /// Human-readable name (e.g. "Acme Corp").
    pub name: String,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
}

/// Descriptor for a pre-defined Agent template.
///
/// Templates live as TOML files under `agents/templates/` and are loaded
/// at startup. Selecting a template during Agent creation pre-installs the
/// listed skills and pre-populates the `agent.toml` with sensible defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTemplate {
    /// Stable machine identifier (e.g. `"customer-service"`).
    pub id: String,
    /// Display name shown in the Dashboard picker.
    pub name: String,
    /// One-line description shown beneath the template card.
    pub description: String,
    /// Skill IDs that are pre-installed when this template is selected.
    pub skills: Vec<String>,
    /// Relative path to the source TOML file (informational, for debugging).
    pub toml_path: String,
}
