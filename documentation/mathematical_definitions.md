# Mathematical Definitions: The Collision Manifold

This document formalizes the mathematical signals used within the **Collision Manifold Model** to ensure interpretability and rigor.

---

## 1. The Affective Signal (A-Signal)
The **A-Signal** represents the total systemic tension (friction) across all subsystem collisions.

### Value Mapping
- **$0.0$ (Stability)**: Optimal state. All subsystem pressures are balanced. The model is in a stable attractor state.
- **$1.0$ (Maximum Friction)**: Critical instability. Subsystem pressures are in high conflict (e.g., world reality contradicts internal prediction).

### Implementation
$$A = \tanh(\sum \text{Tension}_{\text{subsystems}})$$
Where $A \in [0, 1)$.

---

## 2. Affective Valence (V)
**Valence** represents the specific pressure from the *Emotions* subsystem relative to the model's internal homeostatic setpoint.

### Value Mapping
- **Positive ($>0$)**: System is currently "above" its homeostatic setpoint (High-Value State).
- **Negative ($<0$)**: System is "below" its homeostatic setpoint (Low-Value State / Negative Friction).
- **Zero ($0.0$)**: System is at its precise homeostatic equilibrium.

---

## 3. Hyper-Plasticity Scaling ($\eta_z$)
The plasticity (learning rate) of the latent state $z$ is a function of the A-Signal.

### Dynamics
$$\eta_z = \eta_{\text{base}} \times (1 + A)$$
- **When $A \to 0$**: $\eta_z \approx \eta_{\text{base}}$. The model maintains its current identity/structure.
- **When $A \to 1$**: $\eta_z \approx 2 \times \eta_{\text{base}}$. The model becomes more malleable, allowing for rapid structural reorganization to resolve tension.

---

## 4. Subsystem Tension (T)
Each subsystem $i$ contributes to the manifold via its own loss-gradient:
$$T_i = \mathcal{L}_i(z, \text{inputs})$$

1.  **Truth Tension ($T_{\text{int}}$)**: Reconstruction error of the Environment.
2.  **Intention Tension ($T_{\text{dec}}$)**: Divergence in policy coherence.
3.  **Persistence Tension ($T_{\text{cla}}$)**: Divergence from historical temporal identity.
4.  **Reflection Tension ($T_{\text{ref}}$)**: Failure of self-prediction (Mirror Test).
