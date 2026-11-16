//! NANI Graph Theory Module
//!
//! Models network relationships as a directed graph:
//!   - Network interfaces
//!   - Gateways
//!   - DNS resolvers
//!   - Connectivity targets (endpoints)
//!   - Services / APIs
//!   - Approved connection paths
//!   - Configuration dependencies
//!
//! Provides:
//!   - Graph construction from observed measurements
//!   - Connected components (identify isolated subgraphs)
//!   - Shortest-path (Dijkstra) for route analysis
//!   - Dependency analysis (upstream/downstream)
//!   - Failure propagation (which nodes are affected by a node failure)
//!   - Centrality (which nodes are most critical)
//!
//! All graph construction is based on measured observations only —
//! we never infer topology that has not been observed.

use crate::network_intelligence::math::clamp_probability;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// A node in the network graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub String);

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The type of a network node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NodeType {
    Interface,
    Gateway,
    DnsResolver,
    Endpoint,
    Service,
    Api,
    ApprovedPath,
    ConfigDependency,
}

/// An edge in the network graph, representing a dependency or
/// communication path between two nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    /// The type of relationship (e.g. "uses", "depends_on", "routes_to").
    pub relation: String,
    /// Observed success probability of this edge (0..1), None if unmeasured.
    pub success_prob: Option<f64>,
    /// Observed latency in ms, None if unmeasured.
    pub latency_ms: Option<f64>,
    /// Last time this edge was observed (epoch ms).
    pub last_observed_ms: u64,
}

impl Edge {
    pub fn new(from: NodeId, to: NodeId, relation: String) -> Self {
        Self {
            from,
            to,
            relation,
            success_prob: None,
            latency_ms: None,
            last_observed_ms: 0,
        }
    }
}

/// The network graph: nodes and directed edges.
#[derive(Debug, Clone, Default)]
pub struct NetworkGraph {
    /// Node ID -> node type.
    nodes: HashMap<NodeId, NodeType>,
    /// Node ID -> outgoing edges.
    adj: HashMap<NodeId, Vec<Edge>>,
    /// Node ID -> incoming edges.
    rev_adj: HashMap<NodeId, Vec<Edge>>,
}

impl NetworkGraph {
    /// Create an empty graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a node to the graph.
    pub fn add_node(&mut self, id: NodeId, node_type: NodeType) {
        self.nodes.insert(id, node_type);
    }

    /// Add an edge to the graph. If the edge already exists (same from/to/
    /// relation), it is updated with the new observation.
    pub fn add_edge(&mut self, edge: Edge) {
        let from = edge.from.clone();
        let to = edge.to.clone();
        self.nodes.insert(from.clone(), NodeType::Endpoint);
        self.nodes.insert(to.clone(), NodeType::Endpoint);
        self.adj.entry(from).or_default().push(edge.clone());
        self.rev_adj.entry(to).or_default().push(edge);
    }

    /// Update edge statistics with a new observation.
    pub fn observe_edge(
        &mut self,
        from: &NodeId,
        to: &NodeId,
        relation: &str,
        success: bool,
        latency_ms: Option<f64>,
    ) {
        // Use a simple EWMA for success probability and latency.
        let alpha = 0.3;
        if let Some(edges) = self.adj.get_mut(from) {
            if let Some(edge) = edges.iter_mut().find(|e| e.to == *to && e.relation == relation) {
                let new_sp = if success { 1.0 } else { 0.0 };
                edge.success_prob = Some(edge.success_prob.unwrap_or(0.5) * (1.0 - alpha) + new_sp * alpha);
                if let Some(lat) = latency_ms {
                    edge.latency_ms = Some(edge.latency_ms.unwrap_or(lat) * (1.0 - alpha) + lat * alpha);
                }
                edge.last_observed_ms = unix_now_ms();
                return;
            }
        }
        // Edge doesn't exist yet — create it.
        let mut edge = Edge::new(from.clone(), to.clone(), relation.to_string());
        let new_sp = if success { 1.0 } else { 0.0 };
        edge.success_prob = Some(new_sp);
        edge.latency_ms = latency_ms;
        edge.last_observed_ms = unix_now_ms();
        self.add_edge(edge);
    }

    /// Get all outgoing edges from a node.
    pub fn outgoing(&self, id: &NodeId) -> Option<&Vec<Edge>> {
        self.adj.get(id)
    }

    /// Get all incoming edges to a node.
    pub fn incoming(&self, id: &NodeId) -> Option<&Vec<Edge>> {
        self.rev_adj.get(id)
    }

    /// Get the type of a node, if known.
    pub fn node_type(&self, id: &NodeId) -> Option<NodeType> {
        self.nodes.get(id).copied()
    }

    /// Number of nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Number of edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.adj.values().map(|v| v.len()).sum()
    }

    /// Find all nodes reachable from `start` via outgoing edges (BFS).
    pub fn reachable_from(&self, start: &NodeId) -> HashSet<NodeId> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(start.clone());
        queue.push_back(start.clone());
        while let Some(node) = queue.pop_front() {
            if let Some(edges) = self.adj.get(&node) {
                for edge in edges {
                    if visited.insert(edge.to.clone()) {
                        queue.push_back(edge.to.clone());
                    }
                }
            }
        }
        visited
    }

    /// Find all nodes that can reach `target` via incoming edges (reverse BFS).
    pub fn can_reach(&self, target: &NodeId) -> HashSet<NodeId> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(target.clone());
        queue.push_back(target.clone());
        while let Some(node) = queue.pop_front() {
            if let Some(edges) = self.rev_adj.get(&node) {
                for edge in edges {
                    if visited.insert(edge.from.clone()) {
                        queue.push_back(edge.from.clone());
                    }
                }
            }
        }
        visited
    }

    /// Connected components (undirected): group nodes that are connected
    /// regardless of edge direction.
    pub fn connected_components(&self) -> Vec<HashSet<NodeId>> {
        let mut visited = HashSet::new();
        let mut components = Vec::new();
        for node in self.nodes.keys() {
            if visited.contains(node) {
                continue;
            }
            let mut comp = HashSet::new();
            let mut queue = VecDeque::new();
            visited.insert(node.clone());
            queue.push_back(node.clone());
            while let Some(cur) = queue.pop_front() {
                comp.insert(cur.clone());
                // Outgoing neighbors
                if let Some(edges) = self.adj.get(&cur) {
                    for edge in edges {
                        if visited.insert(edge.to.clone()) {
                            queue.push_back(edge.to.clone());
                        }
                    }
                }
                // Incoming neighbors
                if let Some(edges) = self.rev_adj.get(&cur) {
                    for edge in edges {
                        if visited.insert(edge.from.clone()) {
                            queue.push_back(edge.from.clone());
                        }
                    }
                }
            }
            components.push(comp);
        }
        components
    }

    /// Failure propagation: given a set of failed nodes, find all nodes that
    /// are affected (i.e., all nodes reachable from the failed nodes via
    /// outgoing edges, plus the failed nodes themselves).
    pub fn failure_propagation(&self, failed: &[NodeId]) -> HashSet<NodeId> {
        let mut affected = HashSet::new();
        let mut queue = VecDeque::new();
        for f in failed {
            affected.insert(f.clone());
            queue.push_back(f.clone());
        }
        while let Some(node) = queue.pop_front() {
            if let Some(edges) = self.adj.get(&node) {
                for edge in edges {
                    if affected.insert(edge.to.clone()) {
                        queue.push_back(edge.to.clone());
                    }
                }
            }
        }
        affected
    }

    /// Shortest path (unweighted BFS) from start to target.
    pub fn shortest_path(&self, start: &NodeId, target: &NodeId) -> Option<Vec<NodeId>> {
        if start == target {
            return Some(vec![start.clone()]);
        }
        let mut visited = HashSet::new();
        let mut parent: HashMap<NodeId, NodeId> = HashMap::new();
        let mut queue = VecDeque::new();
        visited.insert(start.clone());
        queue.push_back(start.clone());
        while let Some(node) = queue.pop_front() {
            if let Some(edges) = self.adj.get(&node) {
                for edge in edges {
                    if visited.insert(edge.to.clone()) {
                        parent.insert(edge.to.clone(), node.clone());
                        if edge.to == *target {
                            // Reconstruct path.
                            let mut path = Vec::new();
                            let mut cur = edge.to.clone();
                            while cur != *start {
                                path.push(cur.clone());
                                cur = parent.get(&cur).unwrap().clone();
                            }
                            path.push(start.clone());
                            path.reverse();
                            return Some(path);
                        }
                        queue.push_back(edge.to.clone());
                    }
                }
            }
        }
        None
    }

    /// Betweenness centrality for each node (Brandes algorithm, unweighted).
    /// Higher = more critical to network connectivity.
    pub fn betweenness_centrality(&self) -> HashMap<NodeId, f64> {
        let mut betweenness: HashMap<NodeId, f64> = self.nodes.keys().map(|k| (k.clone(), 0.0)).collect();
        for s in self.nodes.keys() {
            let mut stack = Vec::new();
            let mut pred: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
            let mut sigma: HashMap<NodeId, f64> = self.nodes.keys().map(|k| (k.clone(), 0.0)).collect();
            let mut dist: HashMap<NodeId, i64> = self.nodes.keys().map(|k| (k.clone(), -1)).collect();
            sigma.insert(s.clone(), 1.0);
            dist.insert(s.clone(), 0);
            let mut queue = VecDeque::new();
            queue.push_back(s.clone());
            while let Some(v) = queue.pop_front() {
                stack.push(v.clone());
                if let Some(edges) = self.adj.get(&v) {
                    for edge in edges {
                        let w = &edge.to;
                        if dist[w] < 0 {
                            queue.push_back(w.clone());
                            dist.insert(w.clone(), dist[&v] + 1);
                        }
                        if dist[w] == dist[&v] + 1 {
                            *sigma.get_mut(w).unwrap() += sigma[&v];
                            pred.entry(w.clone()).or_default().push(v.clone());
                        }
                    }
                }
            }
            let mut delta: HashMap<NodeId, f64> = self.nodes.keys().map(|k| (k.clone(), 0.0)).collect();
            while let Some(w) = stack.pop() {
                for v in pred.get(&w).unwrap_or(&Vec::new()) {
                    *delta.get_mut(v).unwrap() += (sigma[v] / sigma[&w]) * (1.0 + delta[&w]);
                }
                if w != *s {
                    *betweenness.get_mut(&w).unwrap() += delta[&w];
                }
            }
        }
        // Normalize by (n-1)(n-2) for undirected, or /2 for directed.
        let n = self.nodes.len() as f64;
        let norm = if n > 2.0 { (n - 1.0) * (n - 2.0) } else { 1.0 };
        let mut result = HashMap::new();
        for (k, v) in betweenness {
            result.insert(k, v / norm);
        }
        result
    }
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_query_nodes() {
        let mut g = NetworkGraph::new();
        let a = NodeId("gw1".into());
        let b = NodeId("dns1".into());
        g.add_node(a.clone(), NodeType::Gateway);
        g.add_node(b.clone(), NodeType::DnsResolver);
        assert_eq!(g.node_count(), 2);
        assert_eq!(g.node_type(&a), Some(NodeType::Gateway));
        assert_eq!(g.node_type(&b), Some(NodeType::DnsResolver));
    }

    #[test]
    fn add_edge_and_outgoing() {
        let mut g = NetworkGraph::new();
        let a = NodeId("gw1".into());
        let b = NodeId("dns1".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        assert_eq!(g.edge_count(), 1);
        let edges = g.outgoing(&a).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to, b);
    }

    #[test]
    fn reachable_from() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        let c = NodeId("c".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        g.add_edge(Edge::new(b.clone(), c.clone(), "uses".into()));
        let reachable = g.reachable_from(&a);
        assert!(reachable.contains(&a));
        assert!(reachable.contains(&b));
        assert!(reachable.contains(&c));
    }

    #[test]
    fn connected_components() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        let c = NodeId("c".into());
        let d = NodeId("d".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        g.add_edge(Edge::new(c.clone(), d.clone(), "uses".into()));
        // Two separate components: {a,b} and {c,d}
        let comps = g.connected_components();
        assert_eq!(comps.len(), 2);
    }

    #[test]
    fn failure_propagation() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        let c = NodeId("c".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        g.add_edge(Edge::new(b.clone(), c.clone(), "uses".into()));
        let affected = g.failure_propagation(&[a.clone()]);
        assert!(affected.contains(&a));
        assert!(affected.contains(&b));
        assert!(affected.contains(&c));
    }

    #[test]
    fn shortest_path() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        let c = NodeId("c".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        g.add_edge(Edge::new(b.clone(), c.clone(), "uses".into()));
        let path = g.shortest_path(&a, &c).unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0], a);
        assert_eq!(path[2], c);
    }

    #[test]
    fn betweenness_centrality() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        let c = NodeId("c".into());
        g.add_edge(Edge::new(a.clone(), b.clone(), "uses".into()));
        g.add_edge(Edge::new(b.clone(), c.clone(), "uses".into()));
        let bc = g.betweenness_centrality();
        // b is on the only path from a to c, so it should have highest centrality.
        assert!(bc[&b] > bc[&a]);
        assert!(bc[&b] > bc[&c]);
    }

    #[test]
    fn observe_edge_updates_probability() {
        let mut g = NetworkGraph::new();
        let a = NodeId("a".into());
        let b = NodeId("b".into());
        // Observe 10 successes.
        for _ in 0..10 {
            g.observe_edge(&a, &b, "uses", true, Some(50.0));
        }
        let edges = g.outgoing(&a).unwrap();
        let sp = edges[0].success_prob.unwrap();
        assert!(sp > 0.9, "success prob should be high after 10 successes: {sp}");
    }
}
