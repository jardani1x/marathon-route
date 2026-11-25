"""
SGIM 2026 adidas Half Marathon (21.0975 km) - 3D course model for Blender.

Run:  Blender > Scripting > Open this file > Run Script      (or: blender --python sgim26_half_marathon_blender.py)
Builds a collection "SGIM26 Half Marathon": street-map underlay, the course as a 3D curve with
exaggerated height, an elevation curtain, kilometre markers, landmarks, and a runner figure that covers
the course on a race clock set by TARGET_TIME, with a chase camera.

Source and limits
- The course is traced from the organiser's route map dated 17 August 2026 ("subject to change").
- Heights are digitised from that map's elevation profile.
- With USE_LIVE_OSM = True the script asks the OpenStreetMap Overpass API for roads near the trace and
  snaps the course to them. If that fails for any reason it keeps the built-in trace and says so.
- Built-in trace positions come from landmark-based georeferencing: expect tens of metres of error.
- Unofficial. Road data (c) OpenStreetMap contributors (ODbL) when fetched.
"""
import base64, json, math, os, tempfile, urllib.parse, urllib.request

# ----------------------------------------------------------------------------- settings
VERTICAL_EXAGGERATION = 20.0     # the course spans only 23 m of height; 1.0 = true scale
SCALE = 0.01                     # Blender units per metre (0.01 -> 1 unit = 100 m)
USE_LIVE_OSM = True              # fetch OpenStreetMap roads and snap the course to them
OVERPASS_TIMEOUT_S = 60
CLEAR_PREVIOUS = True            # remove an earlier "SGIM26 Half Marathon" collection first
ADD_FLYTHROUGH = True            # animated runner + chase camera
TARGET_TIME = "2:00:00"          # runner's finish time, h:mm:ss
PACING = "effort"                # "effort" = slower uphill / faster downhill, "even" = constant speed
TIME_COMPRESSION = 144.0         # race seconds per second of animation (144 -> a 2:00:00 race plays in 50 s)
FPS = 24
RUNNER_HEIGHT = 0.6              # Blender units; far larger than life so the figure is visible
COLLECTION_NAME = "SGIM26 Half Marathon"
OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

