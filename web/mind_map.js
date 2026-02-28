// --- Mind Map Prototype REFINED ---
const BRIDGE_URL = "http://localhost:8001";
const DEFAULT_ACTOR = "Laura_Stevens";

let graphData = { nodes: [], links: [] };
let chart = null;

// --- REAL DATA TAXONOMY ---
const TYPE_COLORS = {
    'character': '#ef5350',
    'place': '#66bb6a',
    'concept': '#42a5f5',
    'event': '#ffca28',
    'object': '#ab47bc',
    'literal': '#888888'
};

const DEFAULT_COLOR = '#999';

// --- Initialization ---
async function init() {
    console.log("[MindMap] Initializing Neural Connectome (REALITY)...");

    // 0. Load Persistent Actor
    const savedActor = localStorage.getItem('active_actor_id') || DEFAULT_ACTOR;
    document.querySelector('.brand').innerHTML = `NEURAL BRIDGE <span class="muted" style="font-weight: 300; font-size: 0.9rem;">| ${savedActor.replace('_', ' ')}</span>`;

    // 1. Setup Force Graph
    const elem = document.getElementById('thought-web');
    chart = ForceGraph()(elem)
        .nodeId('id')
        .nodeLabel(node => `[${node.group.toUpperCase()}] ${node.label}`)
        .nodeCanvasObject((node, ctx, globalScale) => {
            const label = node.label;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px Sans-Serif`;
            const textWidth = ctx.measureText(label).width;
            const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2);

            // Confidence determines opacity (Reality Check)
            const alpha = node.confidence || 0.9;
            ctx.globalAlpha = alpha;

            ctx.fillStyle = node.color || DEFAULT_COLOR;
            if (node.group === 'literal') {
                ctx.fillRect(node.x - 4, node.y - 4, 8, 8); // Literals are small boxes
            } else {
                ctx.beginPath();
                ctx.arc(node.x, node.y, (node.val || 5) * alpha, 0, 2 * Math.PI, false);
                ctx.fill();
            }

            ctx.globalAlpha = 1.0;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#bbb';
            ctx.fillText(label, node.x, node.y + (node.val || 5) + 5);

            node.__bckgDimensions = bckgDimensions;
        })
        .linkColor(() => '#333')
        .linkWidth(l => (l.confidence || 1) * 2)
        .linkDirectionalArrowLength(3)
        .linkDirectionalArrowRelPos(1)
        .linkCurvature(0.1)
        .onNodeClick(node => inspectNode(node));

    // 2. Load Real UI State
    await refreshAll();
    setupResizer();
    setupTimelineScroll();

    // Auto-refresh every 30s to see the "mess" grow
    setInterval(refreshAll, 30000);
}

async function refreshAll() {
    const actor = localStorage.getItem('active_actor_id') || DEFAULT_ACTOR;
    updateSyncStatus(false, "Syncing Neurons...");

    try {
        await Promise.all([
            loadKG(actor),
            loadInterests(actor),
            loadTimeline(actor)
        ]);
        updateSyncStatus(true, "Neural Link Active (Real Data)");
    } catch (err) {
        console.error("Refresh failed:", err);
        updateSyncStatus(false, "Sync Error: Check Bridge");
    }
}

async function loadKG(actor) {
    const resp = await fetch(`${BRIDGE_URL}/kg/${actor}`);
    const data = await resp.json();

    const nodes = [];
    const links = [];
    const literalIds = new Set();

    data.subjects.forEach(s => {
        nodes.push({
            id: s.subject_id,
            label: s.canonical_name,
            group: s.subject_type,
            confidence: s.confidence,
            source: s.source,
            desc: s.description,
            color: TYPE_COLORS[s.subject_type] || DEFAULT_COLOR,
            val: 7
        });

        if (s.relations) {
            s.relations.forEach(r => {
                if (r.object_id) {
                    links.push({
                        source: r.subject_id,
                        target: r.object_id,
                        label: r.predicate,
                        confidence: r.confidence
                    });
                } else if (r.object_literal) {
                    const lId = `lit_${r.relation_id}`;
                    if (!literalIds.has(lId)) {
                        nodes.push({
                            id: lId,
                            label: r.object_literal,
                            group: 'literal',
                            confidence: r.confidence,
                            color: TYPE_COLORS['literal'],
                            val: 4
                        });
                        literalIds.add(lId);
                    }
                    links.push({
                        source: r.subject_id,
                        target: lId,
                        label: r.predicate,
                        confidence: r.confidence
                    });
                }
            });
        }
    });

    graphData = { nodes, links };
    chart.graphData(graphData);
}

async function loadInterests(actor) {
    const resp = await fetch(`${BRIDGE_URL}/get_interests?actor_id=${actor}`);
    const data = await resp.json();
    // Wrap strings into expected object format if necessary
    const list = (data.interests || []).map(i => typeof i === 'string' ? { name: i, desc: "Subject of persistent neural focus." } : i);
    updateInterestsUI(list);
}

async function loadTimeline(actor) {
    const types = ['page', 'chapter', 'book'];
    let allBlocks = [];
    for (const t of types) {
        const resp = await fetch(`${BRIDGE_URL}/get_memory_blocks?actor_id=${actor}&type=${t}&limit=20`);
        const data = await resp.json();
        allBlocks = allBlocks.concat((data.blocks || []).map(b => ({
            id: b.block_id,
            type: b.block_type,
            title: b.block_type.toUpperCase() + ": " + b.source_range,
            summary: b.content,
            time: b.timestamp
        })));
    }
    // Sort by time
    allBlocks.sort((a, b) => new Date(a.time) - new Date(b.time));
    renderTimeline(allBlocks);
    if (allBlocks.length > 0) selectTimelineItem(allBlocks[allBlocks.length - 1]);
}

function setupTimelineScroll() {
    const container = document.querySelector('.timeline-container');
    container.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
            e.preventDefault();
            container.scrollLeft += e.deltaY;
        }
    });
}

// --- Draggable Footer Resizer ---
function setupResizer() {
    const resizer = document.getElementById('footer-resizer');
    const footer = document.querySelector('footer');
    let isDragging = false;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        document.body.style.cursor = 'ns-resize';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight > 180 && newHeight < 600) {
            footer.style.height = `${newHeight}px`;
            // Redraw graph to account for resize
            chart.height(window.innerHeight - 60 - newHeight);
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.style.cursor = 'default';
    });
}

// --- Timeline Rendering ---
function renderTimeline(data) {
    const track = document.getElementById('timeline-track');
    track.innerHTML = "";

    data.forEach(item => {
        const marker = document.createElement('div');
        marker.className = `timeline-marker marker-${item.type}`;

        // Marker Label / Tooltip
        const label = document.createElement('div');
        label.className = "marker-label";
        label.innerHTML = `<span style="opacity:0.5">${item.time.split(' ')[1] || ''}</span><br>${item.title}`;
        marker.appendChild(label);

        marker.onclick = () => selectTimelineItem(item);
        track.appendChild(marker);
    });
}

function selectTimelineItem(item) {
    const typeLabel = document.getElementById('sel-type');
    typeLabel.textContent = `Selected ${item.type}`;
    typeLabel.style.color = item.type === 'book' ? 'var(--book-magenta)' : (item.type === 'chapter' ? 'var(--chapter-green)' : 'var(--page-yellow)');

    document.getElementById('sel-title').textContent = item.title;
    document.getElementById('sel-time').textContent = item.time;
    document.getElementById('sel-summary-input').value = item.summary;
}

// --- Interests Management ---
function updateInterestsUI(list) {
    const container = document.getElementById('interests-list');
    container.innerHTML = "";
    const tooltip = document.getElementById('interest-tooltip');
    const ttTitle = document.getElementById('tooltip-title');
    const ttDesc = document.getElementById('tooltip-desc');

    list.forEach(interest => {
        const tag = document.createElement('div');
        tag.className = "interest-tag";
        tag.innerHTML = `${interest.name} <span class="tag-actions"><span class="tag-action" onclick="event.stopPropagation(); deleteInterest('${interest.name}')">×</span></span>`;

        // Hover Preview
        tag.onmouseenter = (e) => {
            ttTitle.textContent = interest.name;
            ttDesc.textContent = interest.desc;
            tooltip.style.display = 'block';
            tooltip.style.left = `${e.clientX + 15}px`;
            tooltip.style.top = `${e.clientY + 15}px`;
        };
        tag.onmousemove = (e) => {
            tooltip.style.left = `${e.clientX + 15}px`;
            tooltip.style.top = `${e.clientY + 15}px`;
        };
        tag.onmouseleave = () => {
            tooltip.style.display = 'none';
        };

        // Click to persist modal
        tag.onclick = () => {
            tooltip.style.display = 'none';
            showInterestModal(interest);
        };

        container.appendChild(tag);
    });
}

function deleteInterest(name) {
    console.log("[MindMap] Deleting Interest:", name);
    const tags = document.querySelectorAll('.interest-tag');
    tags.forEach(t => {
        if (t.innerText.includes(name)) {
            t.style.opacity = '0';
            t.style.transform = 'scale(0.5)';
            setTimeout(() => t.remove(), 300);
        }
    });
}

// --- Modals ---
window.showInterestModal = (interest) => {
    document.getElementById('modal-title').textContent = `Interest: ${interest.name}`;
    document.getElementById('interest-desc').value = interest.desc || "No description provided.";
    document.getElementById('interest-modal-overlay').classList.add('active');
};

window.closeInterestModal = () => {
    document.getElementById('interest-modal-overlay').classList.remove('active');
};

window.saveInterest = () => {
    console.log("[MindMap] Saving Interest updates...");
    closeInterestModal();
};

function updateSyncStatus(active, text) {
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-text');
    dot.className = active ? "status-dot active" : "status-dot";
    label.textContent = text;
}

function inspectNode(node) {
    const inspector = document.getElementById('node-inspector');
    let relsHtml = `<div class="muted" style="font-size:0.7rem;">NO DIRECT CONNECTIONS</div>`;

    // Find relations in graphData
    const outgoing = graphData.links.filter(l => (l.source.id || l.source) === node.id);
    const incoming = graphData.links.filter(l => (l.target.id || l.target) === node.id);

    if (outgoing.length > 0 || incoming.length > 0) {
        relsHtml = outgoing.map(l => `
            <div class="relation-item" style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 4px; font-size: 0.75rem;">
               <span style="color:var(--accent); font-weight: bold;">(Self)</span> → ${l.label} → <span style="color:#aaa">${l.target.label || l.target}</span>
            </div>
        `).join('') + incoming.map(l => `
            <div class="relation-item" style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 4px; font-size: 0.75rem;">
               <span style="color:#aaa">${l.source.label || l.source}</span> → ${l.label} → <span style="color:var(--accent); font-weight: bold;">(Self)</span>
            </div>
        `).join('');
    }

    inspector.innerHTML = `
        <div class="node-name" style="color:var(--accent); font-size: 1.2rem; line-height: 1.2;">${node.label}</div>
        <div class="node-type muted" style="font-size: 0.65rem; letter-spacing: 1px; margin-top: 4px;">${node.group.toUpperCase()}</div>
        
        <div style="margin-top: 15px; font-size: 0.8rem; line-height: 1.4; color: #ccc;">
            ${node.desc || "<i>No structural description extracted.</i>"}
        </div>

        <div style="margin-top: 15px; display: flex; gap: 10px; font-size: 0.65rem;">
            <div style="padding: 4px 8px; background: #222; border-radius: 4px;">SOURCE: ${node.source || 'UNKNOWN'}</div>
            <div style="padding: 4px 8px; background: #222; border-radius: 4px;">CONF: ${Math.round((node.confidence || 0.9) * 100)}%</div>
        </div>

        <hr style="border:0; border-top:1px solid #333; margin:20px 0;">
        <div class="muted" style="margin-bottom:10px; font-size: 0.7rem; text-transform: uppercase;">Neural Relations:</div>
        <div id="inspector-rels" style="display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto;">
            ${relsHtml}
        </div>
    `;
}

// Start
init();
