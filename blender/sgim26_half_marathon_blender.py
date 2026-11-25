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

# ----------------------------------------------------------------------------- embedded data
DATA = json.loads(r'''{"meta":{"name":"adidas Half Marathon","event":"BYD Singapore International Marathon 2026","date":"2026-12-05","flagOff":"04:30","cutOff":"3:45:00","courseKm":21.0975,"elevGain":68.3,"elevLoss":66.7,"source":"Traced from the organiser's route map dated 17 August 2026","traceLengthM":21267.2},"origin":{"lat":1.29,"lon":103.86,"mPerDegLat":110574.0,"mPerDegLon":111291.786},"route":[[1.292652,103.863877],[1.292979,103.86377],[1.293811,103.863655],[1.294013,103.863587],[1.294143,103.863455],[1.294365,103.863025],[1.294679,103.862586],[1.294773,103.862493],[1.294895,103.862448],[1.295083,103.862453],[1.296454,103.862619],[1.298275,103.862897],[1.298594,103.862961],[1.298929,103.863066],[1.299245,103.863088],[1.299429,103.863196],[1.299626,103.86338],[1.299801,103.863612],[1.299784,103.863841],[1.300129,103.864947],[1.300406,103.86544],[1.300721,103.865878],[1.301099,103.866301],[1.301549,103.86669],[1.302015,103.866964],[1.302319,103.867076],[1.302614,103.867114],[1.302883,103.867092],[1.30319,103.866988],[1.303491,103.866809],[1.30432,103.866201],[1.304423,103.866051],[1.304428,103.865977],[1.30439,103.865882],[1.30365,103.865173],[1.303009,103.864407],[1.302625,103.863886],[1.301958,103.86287],[1.301833,103.862732],[1.301713,103.862688],[1.301586,103.862714],[1.300867,103.863186],[1.300743,103.863187],[1.300635,103.863114],[1.299804,103.861951],[1.298851,103.860675],[1.2978,103.859371],[1.29725,103.858739],[1.296735,103.858222],[1.29594,103.85753],[1.295177,103.85707],[1.293053,103.855721],[1.292677,103.855507],[1.291736,103.85503],[1.291213,103.85481],[1.290474,103.854543],[1.289457,103.854259],[1.288687,103.854105],[1.286835,103.853851],[1.28636,103.853741],[1.285814,103.853583],[1.284734,103.853227],[1.28411,103.852965],[1.283144,103.852476],[1.282341,103.852026],[1.282193,103.851912],[1.282078,103.851773],[1.282055,103.851717],[1.282063,103.851658],[1.282255,103.851306],[1.282264,103.851231],[1.282231,103.851136],[1.282117,103.851024],[1.281443,103.850528],[1.28112,103.850036],[1.2809,103.849955],[1.280465,103.849681],[1.279152,103.848924],[1.27882,103.848826],[1.278416,103.848611],[1.277817,103.848243],[1.277538,103.847954],[1.277146,103.847665],[1.276602,103.847219],[1.275926,103.846557],[1.275502,103.846179],[1.274114,103.845014],[1.272724,103.843895],[1.272371,103.843568],[1.272324,103.843479],[1.272311,103.843374],[1.272309,103.84208],[1.272286,103.841731],[1.272303,103.841628],[1.27238,103.841458],[1.272402,103.841356],[1.272395,103.840548],[1.272371,103.840421],[1.272268,103.840246],[1.272253,103.840116],[1.272261,103.839821],[1.272362,103.839555],[1.272366,103.839232],[1.27233,103.838831],[1.272218,103.838632],[1.272197,103.838532],[1.272169,103.837509],[1.272278,103.837103],[1.272255,103.837004],[1.272163,103.836847],[1.27214,103.836719],[1.272149,103.836505],[1.272237,103.836254],[1.272253,103.836095],[1.272221,103.835477],[1.2722,103.835404],[1.272105,103.835254],[1.272084,103.835154],[1.272056,103.834212],[1.272077,103.83411],[1.272153,103.833944],[1.272162,103.833868],[1.272038,103.833621],[1.272027,103.833354],[1.272042,103.833194],[1.272098,103.832987],[1.272104,103.832855],[1.272045,103.83251],[1.271894,103.83205],[1.271717,103.831656],[1.271466,103.831255],[1.27165,103.831552],[1.271797,103.83184],[1.271998,103.832368],[1.272103,103.832868],[1.272089,103.832971],[1.272021,103.83314],[1.272017,103.833271],[1.272046,103.833371],[1.272144,103.833522],[1.272167,103.833621],[1.272166,103.83416],[1.272061,103.834452],[1.272055,103.83472],[1.272089,103.835203],[1.272215,103.835449],[1.272251,103.835849],[1.272247,103.836199],[1.27215,103.836502],[1.27214,103.836716],[1.272162,103.836844],[1.272253,103.837001],[1.272278,103.8371],[1.272264,103.837205],[1.272171,103.837479],[1.272168,103.838126],[1.272203,103.838581],[1.272321,103.838804],[1.272338,103.838907],[1.272365,103.839714],[1.272346,103.839817],[1.272258,103.840033],[1.272253,103.840463],[1.272271,103.840592],[1.272375,103.840767],[1.272394,103.840868],[1.272399,103.841352],[1.272305,103.841597],[1.272285,103.841727],[1.27231,103.842103],[1.272311,103.843397],[1.272332,103.843556],[1.272392,103.843705],[1.272487,103.843835],[1.272624,103.843965],[1.274478,103.845457],[1.275483,103.846321],[1.276557,103.847349],[1.276925,103.847668],[1.277262,103.847895],[1.27869,103.848774],[1.278812,103.848831],[1.279049,103.848875],[1.279174,103.848923],[1.280762,103.849853],[1.28117,103.850164],[1.281451,103.850519],[1.281776,103.850709],[1.282127,103.851022],[1.282236,103.851138],[1.28227,103.85126],[1.28221,103.851432],[1.281424,103.852659],[1.279739,103.855201],[1.279332,103.855869],[1.277873,103.858076],[1.277751,103.858285],[1.277705,103.858524],[1.277553,103.858776],[1.277176,103.859337],[1.276922,103.859573],[1.276718,103.859858],[1.27583,103.861212],[1.275739,103.861377],[1.275693,103.86153],[1.275694,103.861663],[1.275726,103.861763],[1.275785,103.861851],[1.275885,103.861941],[1.278086,103.863369],[1.278184,103.863405],[1.278419,103.863423],[1.278539,103.863481],[1.279069,103.863856],[1.279557,103.864283],[1.279642,103.864414],[1.279707,103.864697],[1.279998,103.865151],[1.280147,103.865438],[1.280258,103.865713],[1.280388,103.866123],[1.280567,103.86638],[1.280608,103.866645],[1.280605,103.867102],[1.280562,103.86745],[1.280302,103.867885],[1.280246,103.867967],[1.279925,103.868795],[1.279921,103.868926],[1.279996,103.869181],[1.279981,103.86931],[1.279504,103.870123],[1.279419,103.870319],[1.27941,103.870424],[1.279433,103.870555],[1.279509,103.870813],[1.27958,103.870922],[1.279693,103.870966],[1.279944,103.870894],[1.280155,103.870917],[1.280258,103.870905],[1.280377,103.870845],[1.280686,103.870626],[1.281102,103.87028],[1.281637,103.869746],[1.28197,103.869321],[1.282013,103.869225],[1.282017,103.86915],[1.281975,103.869059],[1.281877,103.868969],[1.280673,103.868241],[1.280545,103.868143],[1.280482,103.868059],[1.280457,103.867986],[1.280456,103.867881],[1.28055,103.867461],[1.280609,103.866953],[1.280607,103.866629],[1.280566,103.866255],[1.280467,103.865808],[1.280334,103.865426],[1.280174,103.865085],[1.279946,103.864718],[1.279548,103.864279],[1.279204,103.863974],[1.278528,103.863479],[1.277525,103.862836],[1.277443,103.862768],[1.277389,103.862682],[1.277381,103.862608],[1.2774,103.862532],[1.277622,103.862163],[1.277686,103.861932],[1.277686,103.861744],[1.277614,103.861129],[1.277592,103.860646],[1.277628,103.860382],[1.277622,103.860279],[1.277577,103.860185],[1.277504,103.860108],[1.277232,103.859942],[1.27714,103.859949],[1.276978,103.86008],[1.276882,103.860114],[1.276798,103.860087],[1.27677,103.860006],[1.276957,103.859543],[1.277164,103.859341],[1.277672,103.858576],[1.277799,103.858442],[1.27792,103.858412],[1.278069,103.858466],[1.279888,103.859585],[1.281331,103.860385],[1.282191,103.860784],[1.282985,103.861056],[1.283828,103.861256],[1.284957,103.861394],[1.285552,103.861428],[1.288129,103.861429],[1.288992,103.861514],[1.289365,103.861581],[1.289889,103.861718],[1.290716,103.86198],[1.291652,103.862335],[1.292102,103.862433],[1.292587,103.862456],[1.292986,103.86238],[1.293264,103.862277],[1.293604,103.862057],[1.29432,103.86136],[1.294928,103.860909],[1.295238,103.860742],[1.295488,103.86064],[1.295828,103.860551],[1.296042,103.86054],[1.296128,103.860585],[1.296161,103.860648],[1.296114,103.860987],[1.296117,103.861175],[1.29616,103.861357],[1.296254,103.86155],[1.296456,103.861802],[1.297344,103.862635],[1.298447,103.862929],[1.29894,103.863068],[1.299255,103.863091],[1.2995,103.863255],[1.299872,103.863682],[1.300026,103.863784],[1.300156,103.863795],[1.30052,103.863696],[1.300789,103.863685],[1.30097,103.863733],[1.301166,103.863873],[1.301442,103.864206],[1.303388,103.866862],[1.304476,103.868439],[1.30496,103.869186],[1.305124,103.869398],[1.305246,103.869636],[1.305816,103.870521],[1.306182,103.87115],[1.306468,103.871731],[1.306652,103.872208],[1.306838,103.873295],[1.306911,103.874154],[1.306941,103.875202],[1.307019,103.875762],[1.307109,103.876072],[1.307215,103.876319],[1.307353,103.876551],[1.307634,103.876947],[1.307724,103.877112],[1.307788,103.877345],[1.307809,103.877586],[1.307807,103.87799],[1.307779,103.878258],[1.30761,103.878993],[1.307336,103.879752],[1.306895,103.880705],[1.306638,103.88105],[1.306479,103.881142],[1.306295,103.881182],[1.306134,103.881174],[1.306008,103.88113],[1.305878,103.881036],[1.305605,103.880702],[1.305344,103.880293],[1.304973,103.879605],[1.30475,103.879114],[1.304565,103.878636],[1.304417,103.878119],[1.30436,103.877746],[1.304364,103.877478],[1.304442,103.877281],[1.304599,103.877097],[1.304853,103.876896],[1.305186,103.876716],[1.305417,103.876645],[1.305767,103.876603],[1.306037,103.876609],[1.306465,103.876664],[1.306574,103.876614],[1.3066,103.876528],[1.306455,103.876255],[1.306443,103.87599],[1.306387,103.875884],[1.306295,103.875846],[1.305998,103.875834],[1.305872,103.875796],[1.305468,103.875441],[1.305256,103.875336],[1.305207,103.875285],[1.305203,103.875249]],"elev":{"km":[0.0,0.05,0.1,0.15,0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95,1.0,1.05,1.1,1.15,1.2,1.25,1.3,1.35,1.4,1.45,1.5,1.55,1.6,1.65,1.7,1.75,1.8,1.85,1.9,1.95,2.0,2.05,2.1,2.15,2.2,2.25,2.3,2.35,2.4,2.45,2.5,2.55,2.6,2.65,2.7,2.75,2.8,2.85,2.9,2.95,3.0,3.05,3.1,3.15,3.2,3.25,3.3,3.35,3.4,3.45,3.5,3.55,3.6,3.65,3.7,3.75,3.8,3.85,3.9,3.95,4.0,4.05,4.1,4.15,4.2,4.25,4.3,4.35,4.4,4.45,4.5,4.55,4.6,4.65,4.7,4.75,4.8,4.85,4.9,4.95,5.0,5.05,5.1,5.15,5.2,5.25,5.3,5.35,5.4,5.45,5.5,5.55,5.6,5.65,5.7,5.75,5.8,5.85,5.9,5.95,6.0,6.05,6.1,6.15,6.2,6.25,6.3,6.35,6.4,6.45,6.5,6.55,6.6,6.65,6.7,6.75,6.8,6.85,6.9,6.95,7.0,7.05,7.1,7.15,7.2,7.25,7.3,7.35,7.4,7.45,7.5,7.55,7.6,7.65,7.7,7.75,7.8,7.85,7.9,7.95,8.0,8.05,8.1,8.15,8.2,8.25,8.3,8.35,8.4,8.45,8.5,8.55,8.6,8.65,8.7,8.75,8.8,8.85,8.9,8.95,9.0,9.05,9.1,9.15,9.2,9.25,9.3,9.35,9.4,9.45,9.5,9.55,9.6,9.65,9.7,9.75,9.8,9.85,9.9,9.95,10.0,10.05,10.1,10.15,10.2,10.25,10.3,10.35,10.4,10.45,10.5,10.55,10.6,10.65,10.7,10.75,10.8,10.85,10.9,10.95,11.0,11.05,11.1,11.15,11.2,11.25,11.3,11.35,11.4,11.45,11.5,11.55,11.6,11.65,11.7,11.75,11.8,11.85,11.9,11.95,12.0,12.05,12.1,12.15,12.2,12.25,12.3,12.35,12.4,12.45,12.5,12.55,12.6,12.65,12.7,12.75,12.8,12.85,12.9,12.95,13.0,13.05,13.1,13.15,13.2,13.25,13.3,13.35,13.4,13.45,13.5,13.55,13.6,13.65,13.7,13.75,13.8,13.85,13.9,13.95,14.0,14.05,14.1,14.15,14.2,14.25,14.3,14.35,14.4,14.45,14.5,14.55,14.6,14.65,14.7,14.75,14.8,14.85,14.9,14.95,15.0,15.05,15.1,15.15,15.2,15.25,15.3,15.35,15.4,15.45,15.5,15.55,15.6,15.65,15.7,15.75,15.8,15.85,15.9,15.95,16.0,16.05,16.1,16.15,16.2,16.25,16.3,16.35,16.4,16.45,16.5,16.55,16.6,16.65,16.7,16.75,16.8,16.85,16.9,16.95,17.0,17.05,17.1,17.15,17.2,17.25,17.3,17.35,17.4,17.45,17.5,17.55,17.6,17.65,17.7,17.75,17.8,17.85,17.9,17.95,18.0,18.05,18.1,18.15,18.2,18.25,18.3,18.35,18.4,18.45,18.5,18.55,18.6,18.65,18.7,18.75,18.8,18.85,18.9,18.95,19.0,19.05,19.1,19.15,19.2,19.25,19.3,19.35,19.4,19.45,19.5,19.55,19.6,19.65,19.7,19.75,19.8,19.85,19.9,19.95,20.0,20.05,20.1,20.15,20.2,20.25,20.3,20.35,20.4,20.45,20.5,20.55,20.6,20.65,20.7,20.75,20.8,20.85,20.9,20.95,21.0,21.05,21.0975],"m":[12.0,11.96,11.93,11.93,11.93,11.93,11.93,11.93,12.05,12.05,11.93,11.87,11.58,11.4,11.11,11.02,10.86,10.68,10.57,10.44,10.23,10.45,10.55,10.57,10.67,10.45,9.72,8.2,7.0,5.95,4.7,5.71,6.75,7.75,8.98,9.92,10.11,10.11,10.11,10.23,10.23,10.52,10.68,10.91,11.02,11.14,11.02,10.69,10.51,10.11,10.04,10.0,10.0,10.11,10.11,10.11,10.36,10.71,11.02,11.34,11.55,11.38,11.02,10.68,10.39,10.11,10.11,10.11,10.11,10.18,10.3,10.4,10.57,10.68,10.91,11.02,11.57,12.15,12.73,13.34,13.9,13.86,13.75,13.71,13.64,13.3,12.83,12.43,11.91,11.48,11.02,11.02,11.02,11.02,11.02,11.0,10.91,10.65,10.57,10.45,10.23,10.11,10.11,10.11,10.0,10.0,10.0,10.11,10.11,10.35,10.53,10.59,10.86,10.95,11.02,11.14,11.02,10.84,10.57,10.45,10.11,10.11,9.95,9.77,9.66,9.55,9.35,9.32,9.32,9.27,9.2,9.2,9.2,9.2,9.09,9.09,9.2,9.2,9.27,9.32,9.51,9.55,9.41,9.32,9.32,9.32,9.32,9.25,9.2,9.2,9.2,9.14,9.14,9.2,9.2,9.2,9.2,9.2,9.2,9.32,9.32,9.32,9.32,9.32,9.2,9.2,9.2,9.2,9.2,9.19,9.09,9.2,9.3,9.55,9.66,9.66,9.66,9.66,9.66,9.55,9.55,9.66,9.94,10.11,10.45,10.59,10.91,11.06,11.36,11.53,11.82,11.53,11.22,10.94,10.57,10.27,10.11,10.11,10.11,10.1,10.11,10.11,10.2,10.5,10.57,10.68,10.45,10.11,9.66,9.46,9.13,8.75,8.3,7.95,7.52,7.27,7.36,7.42,7.7,7.84,7.95,8.08,8.18,8.3,8.3,8.5,8.84,9.42,10.01,10.57,10.95,11.02,11.02,10.98,10.91,10.9,11.12,11.33,11.48,11.59,11.86,11.93,11.93,11.93,12.0,12.05,11.96,11.93,11.93,11.88,11.82,11.59,11.48,11.36,11.11,11.02,11.23,11.48,11.88,12.07,12.31,11.2,10.07,8.77,7.46,6.2,6.42,6.73,6.95,7.36,7.65,7.84,8.23,8.41,8.7,8.86,8.99,9.09,9.09,9.09,9.09,9.09,9.09,9.09,9.09,8.86,8.43,7.85,7.14,6.48,6.06,6.3,6.89,7.24,7.83,8.18,8.54,8.89,9.23,9.63,9.96,10.11,10.39,10.57,10.68,10.89,10.6,10.45,10.13,10.06,9.77,9.77,9.77,9.77,9.77,9.89,11.2,13.04,14.67,16.34,18.22,20.19,21.75,23.78,25.92,27.9,26.57,25.14,23.68,22.35,20.76,18.09,15.42,13.01,9.91,7.46,7.47,7.91,8.49,9.03,9.43,9.25,8.85,8.56,8.23,7.84,8.23,8.74,9.39,9.91,10.53,10.54,10.27,10.11,9.89,9.66,9.65,9.4,9.3,9.2,9.13,9.2,9.32,9.55,9.66,9.92,10.45,11.06,11.58,12.31,13.0,12.53,12.13,11.55,11.02,10.61,10.25,9.89,9.54,9.19,8.79,8.75,8.86,9.02,9.09,9.2,9.33,9.62,9.8,10.09,10.11,9.91,9.55,9.08,8.61,8.28,8.18,8.3,8.3,8.3,8.3,8.36,8.75,8.83,9.12,9.3,9.32,9.32,9.32,9.32,9.32,9.37,9.55,9.55,9.66,9.72,10.36,11.35,12.25,13.3,14.13,13.94,13.6]},"elevAnchors":[[0,12.0,"F1 Pit"],[1.5,4.7,"Crawford Junction"],[3.5,10.3,"Suntec City / War Memorial"],[7.5,9.2,"Keppel Road U-turn"],[11.75,10.9,"Gardens by the Bay (outbound)"],[13.25,6.2,"Marina Barrage"],[16.25,27.9,"Sheares Bridge"],[18.5,13.0,"Merdeka Bridge"],[21.0975,13.6,"National Stadium"]],"landmarks":[{"name":"F1 Pit Building","kind":"start","lat":1.291519,"lon":103.863483,"blurb":"Flag-off at 4:30 am from the pit straight.","nearKm":16.62,"nearM":129},{"name":"Singapore Flyer","kind":"landmark","lat":1.289153,"lon":103.863807,"blurb":"Observation wheel beside the start area.","nearKm":16.41,"nearM":246},{"name":"Suntec City","kind":"landmark","lat":1.294465,"lon":103.858782,"blurb":"Passed on Nicoll Highway around 3.5 km.","nearKm":3.17,"nearM":206},{"name":"War Memorial Park","kind":"landmark","lat":1.292737,"lon":103.854518,"blurb":"Civilian War Memorial, west of the course near 3.5 km.","nearKm":3.5,"nearM":110},{"name":"Esplanade","kind":"landmark","lat":1.289762,"lon":103.855221,"blurb":"Theatres on the bay, beside Esplanade Drive near 4 km.","nearKm":3.76,"nearM":109},{"name":"Merlion","kind":"landmark","lat":1.286461,"lon":103.854419,"blurb":"Merlion Park, just after the Esplanade Bridge.","nearKm":4.17,"nearM":75},{"name":"Marina Bay Sands","kind":"landmark","lat":1.284053,"lon":103.859401,"blurb":"Across the bay from the course; seen from Marina Boulevard and Sheares Avenue.","nearKm":15.74,"nearM":208},{"name":"Lau Pa Sat","kind":"landmark","lat":1.280228,"lon":103.850394,"blurb":"Hawker centre beside Robinson Road; passed at about 5 km and again at 10 km.","nearKm":5.08,"nearM":84},{"name":"Former Tanjong Pagar Railway Station","kind":"landmark","lat":1.272678,"lon":103.838543,"blurb":"On Keppel Road near 7 km outbound and 8 km on the way back.","nearKm":8.47,"nearM":49},{"name":"Singapore Art Museum","kind":"landmark","lat":1.271403,"lon":103.836362,"blurb":"At Tanjong Pagar Distripark, close to the Keppel Road U-turn.","nearKm":8.21,"nearM":84},{"name":"Gardens by the Bay","kind":"landmark","lat":1.281829,"lon":103.863835,"blurb":"The course loops round the gardens on Marina Gardens Drive, 12 to 14.5 km.","nearKm":13.99,"nearM":230},{"name":"Marina Barrage","kind":"landmark","lat":1.280044,"lon":103.871126,"blurb":"Easternmost point of the course at 13.25 km; lowest point after Crawford Junction.","nearKm":13.15,"nearM":26},{"name":"Benjamin Sheares Bridge","kind":"climb","lat":1.288119,"lon":103.861766,"blurb":"Highest point of the course: 27.9 m at 16.25 km.","nearKm":16.21,"nearM":37},{"name":"Merdeka Bridge","kind":"landmark","lat":1.304806,"lon":103.868733,"blurb":"Nicoll Highway crossing of the Kallang Basin at 18.5 km.","nearKm":18.54,"nearM":49},{"name":"Old Kallang Airport","kind":"landmark","lat":1.308319,"lon":103.873335,"blurb":"Conserved terminal north of Nicoll Highway near 19.5 km.","nearKm":19.14,"nearM":164},{"name":"National Stadium","kind":"finish","lat":1.304565,"lon":103.87432,"blurb":"Finish line inside the stadium at The Kallang.","nearKm":21.1,"nearM":125}],"sections":[{"from":0.0,"to":0.303,"name":"F1 pit straight","road":"the F1 pit straight","note":"Start line beside the F1 Pit Building.","inferred":false},{"from":0.303,"to":0.837,"name":"Republic Boulevard","road":"Republic Boulevard","note":"North from the pit area.","inferred":false},{"from":0.837,"to":1.483,"name":"Republic Avenue","road":"Republic Avenue","note":"Along the Kallang Basin waterfront.","inferred":false},{"from":1.483,"to":1.654,"name":"Crawford Street","road":"Crawford Street","note":"Crawford Junction is the low point of the first half: 4.7 m at 1.5 km.","inferred":false},{"from":1.654,"to":2.118,"name":"Beach Road","road":"Beach Road","note":"South-west along Beach Road.","inferred":false},{"from":2.118,"to":2.239,"name":"Java Road","road":"Java Road","note":"Short link down to Nicoll Highway.","inferred":false},{"from":2.239,"to":3.762,"name":"Nicoll Highway","road":"Nicoll Highway","note":"Past Suntec City and War Memorial Park.","inferred":false},{"from":3.762,"to":4.236,"name":"Esplanade Drive","road":"Esplanade Drive","note":"Over the Esplanade Bridge.","inferred":false},{"from":4.236,"to":4.811,"name":"Fullerton Road and Collyer Quay","road":"Fullerton Road","note":"Past the Merlion.","inferred":false},{"from":4.811,"to":5.75,"name":"Robinson Road","road":"Robinson Road","note":"Through the financial district, past Lau Pa Sat.","inferred":false},{"from":5.75,"to":6.203,"name":"Anson Road","road":"Anson Road","note":"Down to Keppel Road.","inferred":true},{"from":6.203,"to":7.602,"name":"Keppel Road (westbound)","road":"Keppel Road","note":"Out to the U-turn at 7.5 km.","inferred":false},{"from":7.602,"to":9.008,"name":"Keppel Road (eastbound)","road":"Keppel Road","note":"Back past the former railway station.","inferred":false},{"from":9.008,"to":9.482,"name":"Anson Road","road":"Anson Road","note":"Return leg.","inferred":true},{"from":9.482,"to":10.391,"name":"Robinson Road","road":"Robinson Road","note":"Return leg, Lau Pa Sat at about 10 km.","inferred":false},{"from":10.391,"to":11.763,"name":"Marina Boulevard","road":"Marina Boulevard","note":"South-east through Marina Bay to the gardens.","inferred":false},{"from":11.763,"to":12.718,"name":"Marina Gardens Drive","road":"Marina Gardens Drive","note":"Round the south side of Gardens by the Bay.","inferred":false},{"from":12.718,"to":13.624,"name":"Marina Barrage loop","road":"the Marina Barrage loop","note":"Out to the barrage at 13.25 km and back along the waterfront.","inferred":true},{"from":13.624,"to":14.401,"name":"Marina Gardens Drive","road":"Marina Gardens Drive","note":"Return leg on the opposite carriageway.","inferred":false},{"from":14.401,"to":14.784,"name":"Gardens by the Bay service road","road":"the Gardens by the Bay service road","note":"Cut-through west to Marina Boulevard.","inferred":true},{"from":14.784,"to":15.016,"name":"Marina Boulevard","road":"Marina Boulevard","note":"Short stretch north-west.","inferred":false},{"from":15.016,"to":16.973,"name":"Sheares Avenue and Benjamin Sheares Bridge","road":"Sheares Avenue","note":"The climb: 27.9 m at 16.25 km.","inferred":false},{"from":16.973,"to":17.447,"name":"ECP exit ramp","road":"the ECP exit ramp","note":"Off the bridge and round to Republic Boulevard.","inferred":true},{"from":17.447,"to":17.923,"name":"Republic Boulevard","road":"Republic Boulevard","note":"North to Nicoll Highway.","inferred":false},{"from":17.923,"to":19.486,"name":"Nicoll Highway","road":"Nicoll Highway","note":"Over Merdeka Bridge at 18.5 km.","inferred":false},{"from":19.486,"to":20.051,"name":"Mountbatten Road","road":"Mountbatten Road","note":"East past the stadium precinct.","inferred":false},{"from":20.051,"to":20.545,"name":"Stadium Boulevard","road":"Stadium Boulevard","note":"Back west towards the stadium.","inferred":false},{"from":20.545,"to":21.0975,"name":"Stadium Drive to the finish","road":"Stadium Drive","note":"Into the National Stadium.","inferred":false}],"basemap":{"x0":-3938.7,"y0":-3556.9,"x1":3655.1,"y1":2780.6}}''')

BASEMAP_PNG_B64 = '''
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
'''

# ----------------------------------------------------------------------------- geometry core (no bpy)
COURSE_KM = DATA["meta"]["courseKm"]
_O = DATA["origin"]

def to_xy(lat, lon):
    return ((lon - _O["lon"]) * _O["mPerDegLon"], (lat - _O["lat"]) * _O["mPerDegLat"])

def to_ll(x, y):
    return (_O["lat"] + y / _O["mPerDegLat"], _O["lon"] + x / _O["mPerDegLon"])

def cum_len(p):
    L = [0.0]
    for i in range(1, len(p)):
        L.append(L[-1] + math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]))
    return L

def point_at(p, L, s):
    s = max(0.0, min(L[-1], s))
    lo, hi = 0, len(L) - 1
    if s >= L[hi]:
        lo = max(0, hi - 1)
    else:
        while hi - lo > 1:
            m = (lo + hi) // 2
            if L[m] <= s: lo = m
            else: hi = m
    d = L[lo + 1] - L[lo]
    t = (s - L[lo]) / d if d > 0 else 0.0
    dx, dy = p[lo + 1][0] - p[lo][0], p[lo + 1][1] - p[lo][1]
    n = math.hypot(dx, dy) or 1.0
    return (p[lo][0] + dx * t, p[lo][1] + dy * t, dx / n, dy / n)

def resample(p, step):
    L = cum_len(p); total = L[-1]; n = max(1, round(total / step))
    return [point_at(p, L, total * k / n)[:2] for k in range(n + 1)]

def simplify(p, eps):
    if len(p) < 3: return list(p)
    keep = [False] * len(p); keep[0] = keep[-1] = True; st = [(0, len(p) - 1)]
    while st:
        a, b = st.pop()
        if b <= a + 1: continue
        ux, uy = p[b][0] - p[a][0], p[b][1] - p[a][1]; n = math.hypot(ux, uy); best = -1.0; bi = -1
        for i in range(a + 1, b):
            wx, wy = p[i][0] - p[a][0], p[i][1] - p[a][1]
            d = abs(ux * wy - uy * wx) / n if n > 0 else math.hypot(wx, wy)
            if d > best: best, bi = d, i
        if best > eps:
            keep[bi] = True; st.append((a, bi)); st.append((bi, b))
    return [q for q, k in zip(p, keep) if k]

def interp(xs, ys, x):
    if x <= xs[0]: return ys[0]
    if x >= xs[-1]: return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if xs[m] <= x: lo = m
        else: hi = m
    t = (x - xs[lo]) / ((xs[hi] - xs[lo]) or 1.0)
    return ys[lo] + (ys[hi] - ys[lo]) * t

def elev_at(km):
    return interp(DATA["elev"]["km"], DATA["elev"]["m"], km)

def median(a):
    if not a: return 0.0
    b = sorted(a); m = len(b) // 2
    return b[m] if len(b) % 2 else (b[m - 1] + b[m]) / 2.0

_SKIP = {"steps", "proposed", "construction", "corridor", "elevator", "platform", "bus_stop", "rest_area", "services", "razed", "abandoned"}
_FOOT = {"footway", "path", "pedestrian", "cycleway", "bridleway", "track"}

def build_overpass_query(route_ll, radius):
    c = ",".join("%.5f,%.5f" % (a, b) for a, b in route_ll)
    return "[out:json][timeout:60];way[highway](around:%d,%s);out geom qt;" % (radius, c)

def build_overpass_bbox_query(route_ll, pad):
    s = min(p[0] for p in route_ll) - pad; n = max(p[0] for p in route_ll) + pad
    w = min(p[1] for p in route_ll) - pad; e = max(p[1] for p in route_ll) + pad
    return ('[out:json][timeout:90];way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|raceway|'
            'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](%.5f,%.5f,%.5f,%.5f);out geom qt;' % (s, w, n, e))

def parse_overpass(js):
    ways = []
    if not isinstance(js, dict) or not isinstance(js.get("elements"), list): return ways
    for el in js["elements"]:
        if not isinstance(el, dict) or el.get("type") != "way": continue
        geom = el.get("geometry"); tags = el.get("tags") or {}
        hw = tags.get("highway")
        if not isinstance(geom, list) or len(geom) < 2 or not hw or hw in _SKIP or tags.get("area") == "yes": continue
        pts = [to_xy(g["lat"], g["lon"]) for g in geom if isinstance(g, dict) and isinstance(g.get("lat"), (int, float)) and isinstance(g.get("lon"), (int, float))]
        if len(pts) < 2: continue
        ways.append({"id": el.get("id"), "name": tags.get("name") or tags.get("bridge:name") or tags.get("ref") or "", "highway": hw, "foot": hw in _FOOT, "pts": pts})
    return ways

def build_index(ways, cell):
    segs = []; grid = {}
    for wi, w in enumerate(ways):
        pts = w["pts"]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if a[0] == b[0] and a[1] == b[1]: continue
            si = len(segs)
            segs.append((a[0], a[1], b[0], b[1], math.atan2(b[1] - a[1], b[0] - a[0]), wi, w["foot"]))
            for ci in range(math.floor(min(a[0], b[0]) / cell), math.floor(max(a[0], b[0]) / cell) + 1):
                for cj in range(math.floor(min(a[1], b[1]) / cell), math.floor(max(a[1], b[1]) / cell) + 1):
                    grid.setdefault((ci, cj), []).append(si)
    return {"segs": segs, "grid": grid, "cell": cell}

def ang_diff(a, b):
    d = abs(a - b) % math.pi
    return math.pi - d if d > math.pi / 2 else d

def nearest(ix, x, y, heading, R, max_ang, allow_foot, foot_penalty=0.0, prev_way=None, switch_penalty=0.0):
    c = ix["cell"]; best = None; best_score = float("inf"); seen = set(); segs = ix["segs"]; grid = ix["grid"]
    for ci in range(math.floor((x - R) / c), math.floor((x + R) / c) + 1):
        for cj in range(math.floor((y - R) / c), math.floor((y + R) / c) + 1):
            for si in grid.get((ci, cj), ()):
                if si in seen: continue
                seen.add(si)
                ax, ay, bx, by, ang, way, foot = segs[si]
                if foot and not allow_foot: continue
                if ang_diff(ang, heading) > max_ang: continue
                ux, uy = bx - ax, by - ay
                t = ((x - ax) * ux + (y - ay) * uy) / (ux * ux + uy * uy)
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                px, py = ax + ux * t, ay + uy * t
                d = math.hypot(x - px, y - py)
                if d > R: continue
                score = d + (foot_penalty if foot else 0.0) + (switch_penalty if (prev_way is not None and prev_way != way) else 0.0)
                if score < best_score:
                    best_score = score; best = (px, py, d, way, foot, ang)
    return best

def headings(p, span):
    out = []
    for i in range(len(p)):
        a = p[max(0, i - span)]; b = p[min(len(p) - 1, i + span)]
        out.append(math.atan2(b[1] - a[1], b[0] - a[0]))
    return out

def apply_t(T, p):
    a, b, tx, ty = T
    return [(a * x - b * y + tx, b * x + a * y + ty) for x, y in p]

def solve4(A, B):
    M = [list(A[i]) + [B[i]] for i in range(4)]
    for c in range(4):
        p = max(range(c, 4), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-9: return None
        M[c], M[p] = M[p], M[c]
        for r in range(c + 1, 4):
            f = M[r][c] / M[c][c]
            for k in range(c, 5): M[r][k] -= f * M[c][k]
    x = [0.0] * 4
    for i in range(3, -1, -1):
        x[i] = (M[i][4] - sum(M[i][j] * x[j] for j in range(i + 1, 4))) / M[i][i]
    return x

def snap_to_roads(trace, ways, course_m=None, step=10.0):
    """Align the traced course to OSM roads (translation, then scale/rotation), then snap it.
    Returns dict(ok, reason, xy, T, stats). Mirrors the viewer's JavaScript implementation."""
    stats = {"ways": len(ways), "matched": 0.0, "shiftM": 0.0, "scale": 1.0, "rotDeg": 0.0, "lengthM": 0.0, "traceLengthM": 0.0}
    if not ways: return {"ok": False, "reason": "OpenStreetMap returned no roads for this area.", "stats": stats}
    pts = resample(trace, step); stats["traceLengthM"] = cum_len(pts)[-1]
    ix = build_index(ways, 60.0)
    if not ix["segs"]: return {"ok": False, "reason": "OpenStreetMap returned no usable road geometry.", "stats": stats}
    T = (1.0, 0.0, 0.0, 0.0); deg = math.pi / 180
    for _ in range(8):                                   # phase 1: median translation
        cur = apply_t(T, pts); hd = headings(cur, 2); dxs = []; dys = []
        for q, h in zip(cur, hd):
            m = nearest(ix, q[0], q[1], h, 90.0, 20 * deg, False)
            if m: dxs.append(m[0] - q[0]); dys.append(m[1] - q[1])
        if len(dxs) < len(cur) * 0.3: break
        mx, my = median(dxs), median(dys)
        T = (T[0], T[1], T[2] + mx, T[3] + my)
        if math.hypot(mx, my) < 0.4: break
    cx0 = sum(p[0] for p in pts) / len(pts); cy0 = sum(p[1] for p in pts) / len(pts)
    for _ in range(12):                                  # phase 2: point-to-line similarity fit
        cur = apply_t(T, pts); hd = headings(cur, 2); rows = []; res = []
        for p0, q, h in zip(pts, cur, hd):
            m = nearest(ix, q[0], q[1], h, 45.0, 20 * deg, False)
            if m: rows.append((p0[0] - cx0, p0[1] - cy0, -math.sin(m[5]), math.cos(m[5]), m[0], m[1])); res.append(m[2])
        if len(rows) < len(pts) * 0.3: break
        thr = max(8.0, 2.5 * median(res)); A = [[0.0] * 4 for _ in range(4)]; B = [0.0] * 4; n = 0
        for r, e in zip(rows, res):
            if e > thr: continue
            c = (r[2] * r[0] + r[3] * r[1], -r[2] * r[1] + r[3] * r[0], r[2], r[3]); rhs = r[2] * r[4] + r[3] * r[5]
            for u in range(4):
                B[u] += c[u] * rhs
                for v in range(4): A[u][v] += c[u] * c[v]
            n += 1
        if n < 20: break
        sol = solve4(A, B)
        if not sol: break
        sc = math.hypot(sol[0], sol[1]); rot = math.atan2(sol[1], sol[0]) / deg
        if sc < 0.96 or sc > 1.04 or abs(rot) > 2: break
        nT = (sol[0], sol[1], sol[2] - sol[0] * cx0 + sol[1] * cy0, sol[3] - sol[1] * cx0 - sol[0] * cy0)
        moved = abs(nT[2] - T[2]) + abs(nT[3] - T[3]) + abs(nT[0] - T[0]) * 5000 + abs(nT[1] - T[1]) * 5000
        T = nT
        if moved < 0.3: break
    stats["scale"] = math.hypot(T[0], T[1]); stats["rotDeg"] = math.atan2(T[1], T[0]) / deg
    stats["shiftM"] = math.hypot(T[0] * cx0 - T[1] * cy0 + T[2] - cx0, T[1] * cx0 + T[0] * cy0 + T[3] - cy0)
    cur = apply_t(T, pts); hd = headings(cur, 2); out = []; prev = None; matched = 0; used = set()
    for q, h in zip(cur, hd):                            # phase 3: snap
        m = nearest(ix, q[0], q[1], h, 25.0, 30 * deg, True, 8.0, prev, 5.0)
        if m: out.append((m[0], m[1])); prev = m[3]; matched += 1; used.add(m[3])
        else: out.append(q); prev = None
    stats["matched"] = matched / len(cur)
    for _ in range(2):                                   # drop spikes
        for i in range(2, len(out) - 2):
            p0, p1 = out[i - 2], out[i + 2]; ux, uy = p1[0] - p0[0], p1[1] - p0[1]; l = math.hypot(ux, uy)
            if l < 1: continue
            dev = abs(ux * (out[i][1] - p0[1]) - uy * (out[i][0] - p0[0])) / l
            if dev > 14 and l < 4.6 * step:
                out[i] = ((out[i - 1][0] + out[i + 1][0]) / 2, (out[i - 1][1] + out[i + 1][1]) / 2)
    sm = [out[0]] + [(0.25 * out[k - 1][0] + 0.5 * out[k][0] + 0.25 * out[k + 1][0], 0.25 * out[k - 1][1] + 0.5 * out[k][1] + 0.25 * out[k + 1][1]) for k in range(1, len(out) - 1)] + [out[-1]]
    xy = simplify(sm, 0.8); stats["lengthM"] = cum_len(xy)[-1]; stats["waysUsed"] = len(used)
    stats["roadNames"] = sorted({ways[k]["name"] for k in used if ways[k]["name"]})
    res = {"ok": True, "reason": "", "xy": xy, "T": T, "stats": stats}
    target = course_m or stats["traceLengthM"]
    if stats["matched"] < 0.6: res["ok"] = False; res["reason"] = "Only %d%% of the route matched an OpenStreetMap road." % round(stats["matched"] * 100)
    elif stats["shiftM"] > 200: res["ok"] = False; res["reason"] = "The alignment moved the route %d m, which is too far to trust." % round(stats["shiftM"])
    elif abs(stats["lengthM"] / target - 1) > 0.06: res["ok"] = False; res["reason"] = "The snapped route is %.2f km, too far from the certified distance." % (stats["lengthM"] / 1000)
    return res

def parse_time(s):
    """'1:55:00' -> seconds. Raises ValueError on anything else."""
    p = [float(v) for v in str(s).strip().split(":")]
    if len(p) != 3 or min(p) < 0: raise ValueError("TARGET_TIME must look like h:mm:ss")
    return p[0] * 3600 + p[1] * 60 + p[2]

def run_cost(i):
    """Energy cost of running on a gradient, J/kg/m (polynomial from Minetti et al. 2002). i = rise/run."""
    i = max(-0.45, min(0.45, i))
    return ((((155.4 * i - 30.4) * i - 43.3) * i + 46.3) * i + 19.5) * i + 3.6

def build_pacing(target_s, model, step_km=0.01, smooth_km=0.2):
    """(km list, seconds list) for a target finish time. Mirrors the viewer.
    'effort': time per metre scales with run_cost(gradient); only half of the downhill saving is counted (assumption)."""
    n = max(1, round(COURSE_KM / step_km)); km = [0.0]; t = [0.0]; c0 = run_cost(0.0)
    for j in range(1, n + 1):
        k = COURSE_KM * j / n; mid = (k + km[-1]) / 2
        a = max(0.0, mid - smooth_km / 2); b = min(COURSE_KM, mid + smooth_km / 2)
        g = (elev_at(b) - elev_at(a)) / ((b - a) * 1000) if b > a else 0.0
        f = run_cost(g) / c0
        if f < 1: f = 1 - 0.5 * (1 - f)
        t.append(t[-1] + (k - km[-1]) * (f if model == "effort" else 1.0)); km.append(k)
    s = target_s / t[-1]
    t = [v * s for v in t]; t[-1] = target_s
    return km, t

def fetch_osm_ways(trace_xy):
    """Returns (ways, message). ways is [] when nothing usable came back."""
    ll = [to_ll(x, y) for x, y in simplify(trace_xy, 12.0)]
    last = "no endpoint tried"
    for url in OVERPASS_ENDPOINTS:
        for q in (build_overpass_query(ll, 90), build_overpass_bbox_query(ll, 0.002)):
            try:
                req = urllib.request.Request(url, data=("data=" + urllib.parse.quote(q)).encode("ascii"),
                                             headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "sgim26-blender-route/1.0"})
                with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_S) as r:
                    ways = parse_overpass(json.loads(r.read().decode("utf-8")))
                if ways: return ways, "ok"
                last = "empty answer from " + url
            except Exception as e:                       # network, HTTP, JSON: all mean "fall back"
                last = "%s: %s" % (url, e)
    return [], last

# ----------------------------------------------------------------------------- Blender scene
def _emission(bpy, name, rgb, strength=1.0, alpha=1.0, image=None):
    mat = bpy.data.materials.new(name)
    try: mat.use_nodes = True
    except Exception: pass
    nt = mat.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0); em.inputs["Strength"].default_value = strength
    a_src = None
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = image; tex.extension = "CLIP"
        nt.links.new(tex.outputs["Color"], em.inputs["Color"]); a_src = tex.outputs["Alpha"]
    if alpha < 1.0 or a_src is not None:
        tr = nt.nodes.new("ShaderNodeBsdfTransparent"); mix = nt.nodes.new("ShaderNodeMixShader")
        if a_src is not None: nt.links.new(a_src, mix.inputs[0])
        else: mix.inputs[0].default_value = alpha
        nt.links.new(tr.outputs[0], mix.inputs[1]); nt.links.new(em.outputs[0], mix.inputs[2]); nt.links.new(mix.outputs[0], out.inputs["Surface"])
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try: setattr(mat, attr, val)
            except Exception: pass
    else:
        nt.links.new(em.outputs[0], out.inputs["Surface"])
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], alpha)
    return mat

def build_scene(route_xy, frame_T, source_note):
    import bpy
    from mathutils import Vector
    S = SCALE; ZX = VERTICAL_EXAGGERATION * SCALE
    scene = bpy.context.scene
    if CLEAR_PREVIOUS and COLLECTION_NAME in bpy.data.collections:
        old = bpy.data.collections[COLLECTION_NAME]
        for ob in list(old.all_objects): bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(old)
    col = bpy.data.collections.new(COLLECTION_NAME); scene.collection.children.link(col)
    def link(ob): col.objects.link(ob); return ob
    a, b, tx, ty = frame_T
    def fr(x, y): return (a * x - b * y + tx, b * x + a * y + ty)      # map-derived layers follow the OSM alignment

    L = cum_len(route_xy); total = L[-1]
    def pos_km(km):
        x, y, dx, dy = point_at(route_xy, L, total * km / COURSE_KM)
        return x, y, elev_at(km), dx, dy

    m_course = _emission(bpy, "SGIM course", (1.0, 0.06, 0.62), 2.5)
    m_curtain = _emission(bpy, "SGIM curtain", (1.0, 0.06, 0.62), 1.0, alpha=0.22)
    m_label = _emission(bpy, "SGIM label", (0.92, 0.93, 1.0), 1.5)
    m_km = _emission(bpy, "SGIM km", (1.0, 0.65, 0.9), 1.8)
    m_post = _emission(bpy, "SGIM post", (0.25, 0.3, 0.75), 1.0)
    m_runner = _emission(bpy, "SGIM runner", (1.0, 0.66, 0.05), 4.0)
    m_land = _emission(bpy, "SGIM ground", (0.004, 0.006, 0.03), 1.0)

    # ground + street underlay (roads/water/land mask derived from the route map)
    bm = DATA["basemap"]
    png = os.path.join(tempfile.gettempdir(), "sgim26_basemap.png")
    with open(png, "wb") as f: f.write(base64.b64decode(BASEMAP_PNG_B64))
    img = bpy.data.images.load(png, check_existing=False); img.name = "SGIM26 basemap"
    try: img.pack()
    except Exception: pass
    corners = [fr(bm["x0"], bm["y0"]), fr(bm["x1"], bm["y0"]), fr(bm["x1"], bm["y1"]), fr(bm["x0"], bm["y1"])]
    me = bpy.data.meshes.new("SGIM underlay"); me.from_pydata([(x * S, y * S, 0.0) for x, y in corners], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for i, c in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))): uv.data[i].uv = c
    me.materials.append(_emission(bpy, "SGIM underlay", (0.03, 0.05, 0.2), 1.0, image=img)); link(bpy.data.objects.new("Street underlay", me))
    cx = (corners[0][0] + corners[2][0]) / 2 * S; cy = (corners[0][1] + corners[2][1]) / 2 * S
    g = bpy.data.meshes.new("SGIM ground"); r = 400.0
    g.from_pydata([(cx - r, cy - r, -0.02), (cx + r, cy - r, -0.02), (cx + r, cy + r, -0.02), (cx - r, cy + r, -0.02)], [], [(0, 1, 2, 3)])
    g.materials.append(m_land); link(bpy.data.objects.new("Ground", g))

    # course curve (10 m spacing) + curtain
    n = max(2, round(total / 10.0)); pts = []
    for i in range(n + 1):
        km = COURSE_KM * i / n; x, y, el, _, _ = pos_km(km); pts.append((x * S, y * S, el * ZX + 0.02))
    cu = bpy.data.curves.new("SGIM course", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = 0.09; cu.bevel_resolution = 2; cu.use_fill_caps = True
    sp = cu.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for p, c in zip(sp.points, pts): p.co = (c[0], c[1], c[2], 1.0)
    cu.materials.append(m_course); cu.use_path = True
    course = link(bpy.data.objects.new("Course 21.0975 km", cu))
    cm = bpy.data.meshes.new("SGIM curtain"); verts = []; faces = []
    for i, c in enumerate(pts):
        verts += [(c[0], c[1], 0.005), c]
        if i: faces.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
    cm.from_pydata(verts, [], faces); cm.materials.append(m_curtain); link(bpy.data.objects.new("Elevation curtain", cm))

    def post(name, x, y, z0, z1):
        pc = bpy.data.curves.new(name, "CURVE"); pc.dimensions = "3D"; pc.bevel_depth = 0.012
        s2 = pc.splines.new("POLY"); s2.points.add(1); s2.points[0].co = (x, y, z0, 1); s2.points[1].co = (x, y, z1, 1)
        pc.materials.append(m_post); return link(bpy.data.objects.new(name, pc))
    def text(name, body, x, y, z, size, mat):
        tc = bpy.data.curves.new(name, "FONT"); tc.body = body; tc.size = size; tc.align_x = "CENTER"; tc.extrude = 0.004
        tc.materials.append(mat); ob = link(bpy.data.objects.new(name, tc)); ob.location = (x, y, z); ob.rotation_euler = (math.radians(72), 0, 0)
        return ob
    for k in range(0, 22):                               # kilometre markers
        x, y, el, _, _ = pos_km(float(k)); z = el * ZX
        label = "START" if k == 0 else str(k)
        post("km %02d post" % k, x * S, y * S, z, z + 1.1); text("km %02d" % k, label, x * S, y * S, z + 1.15, 0.75 if k % 5 == 0 or k == 0 else 0.55, m_km)
    x, y, el, _, _ = pos_km(COURSE_KM)
    post("finish post", x * S, y * S, el * ZX, el * ZX + 2.6); text("finish", "FINISH 21.0975", x * S, y * S, el * ZX + 2.65, 0.75, m_km)
    for lm in DATA["landmarks"]:                         # landmarks
        if lm["kind"] in ("start", "finish"): continue
        x, y = fr(*to_xy(lm["lat"], lm["lon"]))
        post(lm["name"] + " post", x * S, y * S, 0.0, 2.0); text(lm["name"], lm["name"], x * S, y * S, 2.05, 0.6, m_label)

    # world, overview camera
    try:
        w = scene.world or bpy.data.worlds.new("SGIM world"); scene.world = w
        try: w.use_nodes = True
        except Exception: pass
        bgn = w.node_tree.nodes.get("Background")
        if bgn: bgn.inputs[0].default_value = (0.003, 0.005, 0.02, 1.0)
    except Exception: pass
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; mx = (min(xs) + max(xs)) / 2; my = (min(ys) + max(ys)) / 2
    cam = bpy.data.cameras.new("SGIM overview"); cam.lens = 40; cam.clip_start = 0.1; cam.clip_end = 5000
    cam_ob = link(bpy.data.objects.new("Overview camera", cam))
    cam_ob.location = (mx - 22, my - 58, 44)
    cam_ob.rotation_euler = (Vector((mx, my, 0)) - cam_ob.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam_ob

    if ADD_FLYTHROUGH:
        target_s = parse_time(TARGET_TIME)
        pk, pt = build_pacing(target_s, PACING)
        frames = max(2, round(target_s / TIME_COMPRESSION * FPS))
        cu.path_duration = frames
        # Follow Path measures along the 3D curve, and exaggerated climbs lengthen it, so map km -> 3D fraction
        L3 = [0.0]
        for i in range(1, len(pts)):
            L3.append(L3[-1] + math.dist(pts[i - 1], pts[i]))
        def frac3d(km):
            f = km / COURSE_KM * n; i = min(n - 1, int(f)); return (L3[i] + (L3[i + 1] - L3[i]) * (f - i)) / L3[-1]
        runner = link(bpy.data.objects.new("Runner", None)); runner.empty_display_type = "PLAIN_AXES"; runner.empty_display_size = 0.2
        con = runner.constraints.new("FOLLOW_PATH"); con.target = course; con.use_fixed_location = True; con.use_curve_follow = True
        con.forward_axis = "FORWARD_Y"; con.up_axis = "UP_Z"
        try: bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
        except Exception: pass
        k = 0.0
        while True:                                      # a key every 100 m, timed by the pacing table
            con.offset_factor = min(1.0, frac3d(k)); con.keyframe_insert("offset_factor", frame=1 + interp(pk, pt, k) / target_s * (frames - 1))
            if k >= COURSE_KM: break
            k = min(COURSE_KM, k + 0.1)
        # runner figure: boxes in mid-stride, feet on the course, facing +Y
        H = RUNNER_HEIGHT; verts = []; faces = []
        def box(cx, cy, cz, w, d, h, pitch=0.0):
            c, s_ = math.cos(pitch), math.sin(pitch); o = len(verts)
            for dx, dy, dz in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)):
                x, y, z = dx * w / 2, dy * d / 2, dz * h / 2
                verts.append(((cx + x) * H, (cy + y * c - z * s_) * H, (cz + y * s_ + z * c) * H))
            faces.extend([(o, o + 3, o + 2, o + 1), (o + 4, o + 5, o + 6, o + 7), (o, o + 1, o + 5, o + 4), (o + 1, o + 2, o + 6, o + 5), (o + 2, o + 3, o + 7, o + 6), (o + 3, o, o + 4, o + 7)])
        box(0, 0.02, 0.67, 0.26, 0.15, 0.34, -0.12)            # torso
        box(0, 0.05, 0.92, 0.15, 0.15, 0.16)                   # head
        box(-0.075, 0.12, 0.36, 0.1, 0.1, 0.3, -0.7); box(-0.075, 0.2, 0.14, 0.09, 0.09, 0.26, 0.25)     # leading leg
        box(0.075, -0.1, 0.36, 0.1, 0.1, 0.3, 0.6); box(0.075, -0.3, 0.26, 0.09, 0.09, 0.26, 1.35)       # trailing leg
        box(-0.17, -0.08, 0.7, 0.065, 0.065, 0.22, 0.7); box(0.17, 0.1, 0.7, 0.065, 0.065, 0.22, -0.7)   # arms
        fm = bpy.data.meshes.new("SGIM runner"); fm.from_pydata(verts, [], faces); fm.materials.append(m_runner)
        fig = link(bpy.data.objects.new("Runner figure", fm)); fig.parent = runner; fig.location = (0, 0, cu.bevel_depth)
        c2 = bpy.data.cameras.new("SGIM chase"); c2.lens = 28; c2.clip_start = 0.05; c2.clip_end = 5000
        chase = link(bpy.data.objects.new("Chase camera", c2)); chase.location = (-5.0, -9.0, 5.5)   # fixed offset from the runner, seen from the south-west
        cl = chase.constraints.new("COPY_LOCATION"); cl.target = runner; cl.use_offset = True
        tr = chase.constraints.new("TRACK_TO"); tr.target = runner; tr.track_axis = "TRACK_NEGATIVE_Z"; tr.up_axis = "UP_Y"
        scene.frame_start = 1; scene.frame_end = frames
        try: scene.render.fps = FPS
        except Exception: pass
        col["race"] = "%s finish, %s pacing, %d frames at %d fps (1 s of animation = %g s of race)" % (TARGET_TIME, PACING, frames, FPS, TIME_COMPRESSION)
    try:
        scene.unit_settings.system = "METRIC"; scene.unit_settings.scale_length = 1.0 / S
    except Exception: pass
    col["source"] = source_note
    return col

def main():
    trace = [to_xy(lat, lon) for lat, lon in DATA["route"]]
    route, T, note = trace, (1.0, 0.0, 0.0, 0.0), "Built-in trace of the organiser's map (positions approximate)."
    if USE_LIVE_OSM:
        ways, msg = fetch_osm_ways(trace)
        if not ways:
            print("[SGIM26] OpenStreetMap fetch failed, using the built-in trace. Reason:", msg)
        else:
            res = snap_to_roads(trace, ways, course_m=COURSE_KM * 1000)
            st = res["stats"]
            if res["ok"]:
                route, T = res["xy"], res["T"]
                note = "Snapped to OpenStreetMap roads: %d%% matched, moved %.0f m, scale %+.1f%%, centre-line %.2f km." % (round(st["matched"] * 100), st["shiftM"], (st["scale"] - 1) * 100, st["lengthM"] / 1000)
            else:
                print("[SGIM26] OpenStreetMap result rejected, using the built-in trace. Reason:", res["reason"])
    print("[SGIM26]", note)
    build_scene(route, T, note)
    print("[SGIM26] Built collection '%s'. Vertical exaggeration %gx, 1 Blender unit = %g m." % (COLLECTION_NAME, VERTICAL_EXAGGERATION, 1.0 / SCALE))

if __name__ == "__main__":
    main()
