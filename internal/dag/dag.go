package dag

import "fmt"

type Node struct {
	Name         string
	Outbound     []Edge
	InboundCount int
}

type Edge struct {
	To         string
	BranchName string
}

type Graph struct {
	Nodes map[string]*Node
}

func NewGraph() *Graph {
	return &Graph{Nodes: map[string]*Node{}}
}

func (g *Graph) AddNode(name string) {
	if _, ok := g.Nodes[name]; ok {
		return
	}
	g.Nodes[name] = &Node{Name: name}
}

func (g *Graph) AddEdge(from, to, branch string) error {
	fromNode, ok := g.Nodes[from]
	if !ok {
		return fmt.Errorf("missing node %s", from)
	}
	toNode, ok := g.Nodes[to]
	if !ok {
		return fmt.Errorf("missing node %s", to)
	}
	fromNode.Outbound = append(fromNode.Outbound, Edge{To: to, BranchName: branch})
	toNode.InboundCount++
	return nil
}

func (g *Graph) Roots() []string {
	roots := []string{}
	for name, node := range g.Nodes {
		if node.InboundCount == 0 {
			roots = append(roots, name)
		}
	}
	return roots
}
