# **ÆTHERFIELD Revenue Engine: Dashboard Specification (v2.0)**

## **1\. Executive Summary: The "Operating Layer" Demo**

This dashboard is a **Proof of Concept (PoC)** demonstrating ÆTHERFIELD as an **Infrastructure Layer**. It bridges the gap between the "Fan Journey" and the "Revenue Model" by showing how automated CEL (Creative Experience Layer) triggers drive measurable ROI.

**Demo Goal:** To visualize the "Physical Routing" and "Closed-Loop Attribution" that the £4M Seed funding will productize into a global SaaS platform.

## **2\. Strategic KPI Dashboard (The "Investor View")**

* **Total IRU (Incremental Revenue Uplift):** Live ticker of revenue attributed to CEL interventions.  
* **CEL Efficiency Ratio:** (Total IRU) / (Variable Interaction Costs).  
* **Attribution Confidence:** % of transactions mapped from Pulse \-\> Movement \-\> POS.

## **3\. Core Demo Modules**

### **A. The "Venue Architect" (Editable Digital Twin)**

The demo launches with a **Pre-Configured Wembley Stadium**, but includes a "Draft Mode" for live editing:

* **Node Manipulation:** Drag-and-drop interface to move Merch Stands or Bars.  
* **Zone Geometry:** Click-to-edit polygons for "GA Standing" or "VIP" areas.  
* **Manifest Hot-Swap:** A "Load Venue" button to switch from Wembley to a festival site or arena instantly.

### **B. The "Behavior Logic Engine" (ITTR Rules & Messaging)**

* **Message Specification:** Users define, LED Visuals, and Digital Content.  
* **Contextual Linking:** Link specific messages to the **Editable Nodes**. (e.g., *"If I move this Merch Stand to the North side, the 'Flash Drop' message automatically updates its directional guidance."*)

### **C. The "Interaction Sampler" (Personalized Simulation)**

* **Device Pairing:** Input a phone number to "Join the Simulation."  
* **Live Sampling:** When a behavior triggers, the **actual message** is sent to the investor's phone, synced with a haptic/LED mock-up on screen.  
* **Conversion Proof:** The investor's avatar moves toward the **Current Position** of the edited nodes to complete the transaction.

## **4\. PoC Investment Logic (The "Why Now")**

* **Founding Capability:** Shows that the CEL is software-driven, not a manual crew cost.  
* **Defensible Margin:** Demonstrates the "Per-Interaction" fee structure.  
* **Operational Scale:** The "Venue Architect" proves that deployment is a "Config Upload" away, not a bespoke build.

## **5\. Technical Spec for the Developer Agent**

* **Persistence:** Use a local state or JSON export/import so edits aren't lost on refresh.  
* **Interactive Map UI:** Use SVG onMouseMove logic to allow node movement.  
* **Simulation Loop:** Use simulation\_script.json to drive the "Shadowed Fan" pathing.

**Next Step for Developer Agent:** *Build the React prototype. Ensure the 'Edit Mode' allows for real-time relocation of Merch/Bar nodes, and that the 'Interaction Sampler' uses these new coordinates for the final 'Revenue Bloom' animation.*