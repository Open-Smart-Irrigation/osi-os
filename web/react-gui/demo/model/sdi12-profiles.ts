import type {Sdi12Profile} from '../../src/types/farming';

// Generated from EDGE/osi-sdi12-normalize listProfiles(); source SHA-256: a137e0595b435b700b0795c6f7a4edfd374806e5dfc26183dd930e0816789609
export const SDI12_PROFILES: Sdi12Profile[] = [
  {
    "id": "GENERIC_VWC",
    "label": "Generic SDI-12 (VWC per value, in order)",
    "provisional": false,
    "expectedValues": null,
    "defaultDepthsCm": [],
    "channels": [
      "vwc_1",
      "vwc_2",
      "vwc_3",
      "vwc_4",
      "vwc_5",
      "vwc_6",
      "vwc_7",
      "vwc_8"
    ],
    "depthSlots": [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]
  },
  {
    "id": "SENTEK_ENVIROSCAN",
    "label": "Sentek EnviroSCAN / TriSCAN (configured layout up to 10 modules)",
    "provisional": false,
    "expectedValues": null,
    "defaultDepthsCm": [],
    "channels": [
      "vwc_1",
      "vwc_2",
      "vwc_3",
      "vwc_4",
      "vwc_5",
      "vwc_6",
      "vwc_7",
      "vwc_8"
    ],
    "depthSlots": [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]
  },
  {
    "id": "DELTAT_PR2_4",
    "label": "Delta-T PR2/4 (VWC, up to 8 depths, variable count)",
    "provisional": true,
    "expectedValues": null,
    "defaultDepthsCm": [],
    "channels": [
      "vwc_1",
      "vwc_2",
      "vwc_3",
      "vwc_4",
      "vwc_5",
      "vwc_6",
      "vwc_7",
      "vwc_8"
    ],
    "depthSlots": [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]
  },
  {
    "id": "DELTAT_PR2_6",
    "label": "Delta-T PR2/6 (VWC, up to 8 depths, variable count)",
    "provisional": true,
    "expectedValues": null,
    "defaultDepthsCm": [],
    "channels": [
      "vwc_1",
      "vwc_2",
      "vwc_3",
      "vwc_4",
      "vwc_5",
      "vwc_6",
      "vwc_7",
      "vwc_8"
    ],
    "depthSlots": [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]
  },
  {
    "id": "TENSIOMARK",
    "label": "ecoTech Tensiomark (tension pF + temp)",
    "provisional": true,
    "expectedValues": 2,
    "defaultDepthsCm": [
      30
    ],
    "channels": [
      "swt_1",
      "soil_temp_1"
    ],
    "depthSlots": [
      1
    ]
  },
  {
    "id": "IMKO_PICO64",
    "label": "IMKO TRIME PICO 64 (VWC + temp)",
    "provisional": true,
    "expectedValues": 2,
    "defaultDepthsCm": [
      30
    ],
    "channels": [
      "vwc_1",
      "soil_temp_1"
    ],
    "depthSlots": [
      1
    ]
  },
  {
    "id": "HYDRASCOUT",
    "label": "HydraScout (VWC + temp + EC, 2 depths in v1)",
    "provisional": true,
    "expectedValues": 6,
    "defaultDepthsCm": [
      15,
      30
    ],
    "channels": [
      "vwc_1",
      "soil_temp_1",
      "soil_ec_1",
      "vwc_2",
      "soil_temp_2",
      "soil_ec_2"
    ],
    "depthSlots": [
      1,
      2
    ]
  }
];
