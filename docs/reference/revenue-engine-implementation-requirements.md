# **Implementation Requirements for ÆTHERFIELD "Interaction Sampler"**

To move from the dashboard\_spec.md to a functional Cursor build, the following data and logic gaps must be bridged.

## **1\. Spatial Data & Assets (The "Digital Twin")**

* **The Map Foundation:** We need a coordinate system.  
  * *Requirement:* Provide a simplified SVG or JSON-based floorplan of a venue (e.g., "The O2" or "Wembley").  
  * *Logic:* Cursor needs defined Revenue Nodes (Merch, Bar, VIP Lounge) with x,y coordinates so it can "snap" the fan avatar to these locations.  
* **Z-Axis logic:** How many levels? (e.g., Level 0: Pitch, Level 1: Concourse, Level 2: VIP Boxes).

## **2\. Simulated Fan Behavior (The "Script")**

A "Shadowed Fan" cannot just move randomly; they need a narrative arc for the demo.

* **The "Scripted Journey" Array:** A JSON object defining the demo path:  
  \[  
    { "time": 0, "pos": \[10, 20\], "state": "idle", "label": "Entering Gate G" },  
    { "time": 5, "trigger": "MERCH\_DROP\_CEL", "message": "Exclusive 10min Drop\!" },  
    { "time": 12, "pos": \[45, 80\], "state": "moving", "target": "Merch Node A" },  
    { "time": 15, "action": "REVENUE\_BLOOM", "value": 45.00 }  
  \]

## **3\. The CEL Visual Engine (Aesthetics)**

* **Haptic/LED Mapping:** We need a "Visual Vocabulary."  
  * *Requirement:* CSS animations or Canvas shaders that represent the "AURA" patterns. (e.g., What does a "Gold Fade" actually look like in code? Hex codes and pulse durations).  
* **The "Revenue Bloom":** Define the particle effect. When a transaction happens, should the node glow, expand, or show a floating currency value?

## **4\. Connectivity (The "Live Sample" Bridge)**

* **Messaging Mock-API:** \* *Option A (Low-Fi):* A browser-based "Virtual Phone" window that pops up.  
  * *Option B (Pro-Fi):* Use a **Twilio** or **WhatsApp Business API** key to send the actual SMS to the investor.  
  * *Decision Needed:* Does the user want the "Shadow Fan" to be fully automated, or should the investor's real-world actions (clicking a link in the SMS) drive the avatar on the dashboard?

## **5\. State Management**

* **The "Shadow" Toggle:** A robust state machine that handles:  
  * WAITING\_FOR\_PAIRING (Inputting phone number).  
  * SHADOW\_ACTIVE (Camera locked to avatar).  
  * INTERACTION\_PENDING (Waiting for the investor to "buy" the merch).

## **Next Prompt for Cursor:**

"Based on the dashboard\_spec.md, build a React-based 2D Venue Map using SVG. Create a Fan component that follows a pre-defined path. Implement a ShadowMode state where the camera pans to keep the Fan centered. Add a side panel called 'Message Preview' that displays a mobile UI frame when the Fan reaches a specific coordinate trigger."