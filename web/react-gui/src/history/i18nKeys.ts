export const HistoryI18nKeys = {
  cards: {
    soil: {
      title: 'history.cards.soil.title',
      subtitle: 'history.cards.soil.subtitle',
    },
    dendro: {
      title: 'history.cards.dendro.title',
      subtitle: 'history.cards.dendro.subtitle',
    },
    environment: {
      title: 'history.cards.environment.title',
      subtitle: 'history.cards.environment.subtitle',
    },
    irrigation: {
      title: 'history.cards.irrigation.title',
      subtitle: 'history.cards.irrigation.subtitle',
    },
    gateway: {
      title: 'history.cards.gateway.title',
      subtitle: 'history.cards.gateway.subtitle',
    },
  },
  calendar: {
    label: 'history.calendar.label',
    states: {
      optimal: 'history.calendar.states.optimal',
      dry: 'history.calendar.states.dry',
      wet: 'history.calendar.states.wet',
      irrigated: 'history.calendar.states.irrigated',
      stress: 'history.calendar.states.stress',
      offline: 'history.calendar.states.offline',
      unknown: 'history.calendar.states.unknown',
    },
  },
  interpretation: {
    title: 'history.interpretation.title',
    rootZoneDry: 'history.interpretation.rootZoneDry',
    irrigationResponse: 'history.interpretation.irrigationResponse',
    dendroStress: 'history.interpretation.dendroStress',
    environmentStress: 'history.interpretation.environmentStress',
    gatewaySyncState: 'history.interpretation.gatewaySyncState',
  },
  workspace: {
    title: 'history.workspace.title',
    singleCardMode: 'history.workspace.singleCardMode',
    comparisonMode: 'history.workspace.comparisonMode',
    selectedCards: 'history.workspace.selectedCards',
    pinnedCards: 'history.workspace.pinnedCards',
    unavailablePanel: 'history.workspace.unavailablePanel',
    repairPanel: 'history.workspace.repairPanel',
  },
} as const;
