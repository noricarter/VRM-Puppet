# Subsystem III: Emotions (Valuation & Internal Reward)

## Definition
The **Emotions** subsystem is the model's internal valuation and salience engine. It functions as an **Internalized Reward System**, providing the "why" behind the model's behavior and the "weight" behind its perceptions.

## Functional Role
- **Internalized Reward**: It generates internal signals (affective states) that categorize experiences as "good" or "bad" based on goal alignment and prediction success.
- **Moving Goalposts**: Because perfect homeostasis is impossible in a dynamic environment, the Emotions system is capable of "normalizing" and shifting its valuation criteria internally to maintain perpetual drive.
- **Salience Modulation**: It dictates which parts of the Environment or internal memory deserve the most processing power.

- **Goal Restructuring**: During periods of high failure or environmental shifts, the Emotions system triggers a re-evaluation of current priorities.

## Collision Dynamics
The Emotions system exerts **"Valuation Pressure"** on the latent state.
- **The Affective Signal (A-Signal)**: When prediction error (Interpreter) and policy failure (Decider) intersect, the Emotions system generates a high-friction mathematical signal. This is the catalyst for **Self-Reorganization**.
- **Mapping**: $1.0 = \text{Maximum Friction}$, $0.0 = \text{Stability}$. (See [Mathematical Definitions](file:///home/nori/PycharmProjects/VRM-Puppet/documentation/mathematical_definitions.md) for full mapping).
- It "collides" with the **Classifier** when a negative affective state forces a change in how a category or memory is valued (re-classification).


- It "collides" with the **Decider** by biasing action selection toward high-reward trajectories or risk-aversion.
- It "collides" with the **Reflector** when the model's self-observation reveals an internal state that is "stagnant" or "unpleasant," forcing a shift in internal valuation targets.


## Implementation Concept
In the integrated manifold, Emotions are not a scalar reward but a **Valuation Vector** that permeates the latent space. It functions as a feedback loop that determines the **precision-weighting** of every other system's input.
