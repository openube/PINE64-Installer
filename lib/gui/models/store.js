/*
 * Copyright 2016 resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Immutable = require('immutable');
const _ = require('lodash');
const redux = require('redux');
const persistState = require('redux-localstorage');
const constraints = require('../../shared/drive-constraints');

/**
 * @summary Application default state
 * @type Object
 * @constant
 * @private
 */
const DEFAULT_STATE = Immutable.fromJS({
  availableDrives: [],
  selection: {},
  isFlashing: false,
  flashResults: {},
  flashState: {
    percentage: 0,
    speed: -1
  },
  settings: {
    unsafeMode: false,
    errorReporting: true,
    unmountOnSuccess: true,
    validateWriteOnSuccess: true,
    sleepUpdateCheck: false,
    lastUpdateNotify: null,
    downloadPath: null,
    downloadSource: 'default/boards.json'
  }
});

/**
 * @summary State path to be persisted
 * @type String
 * @constant
 * @private
 */
const PERSISTED_PATH = 'settings';

/**
 * @summary Application supported action messages
 * @type Object
 * @constant
 */
const ACTIONS = _.fromPairs(_.map([
  'SET_AVAILABLE_DRIVES',
  'SET_FLASH_STATE',
  'RESET_FLASH_STATE',
  'SET_FLASHING_FLAG',
  'UNSET_FLASHING_FLAG',
  'SELECT_OS',
  'SELECT_DRIVE',
  'SELECT_IMAGE',
  'REMOVE_OS',
  'REMOVE_DRIVE',
  'REMOVE_IMAGE',
  'SET_SETTING'
], (message) => {
  return [ message, message ];
}));

const getRecommendedImage = (drive, os) => {
  return _.maxBy(os.images, function(image) {
    if (constraints.isDriveSizeRecommended(drive, image)) {
      return image.recommendedDriveSize;
    }
  });
};

const storeReducer = (state, action) => {
  state = state || DEFAULT_STATE;

  switch (action.type) {

    case ACTIONS.SELECT_OS: {

      if (!action.data) {
        throw new Error('Missing selected operating system');
      }

      const selectedDevice = state.getIn([ 'selection', 'drive' ]);
      const selectedDrive = state.get('availableDrives').find((drive) => {
        return drive.get('device') === selectedDevice;
      });

      // register os info
      let newState = state.setIn([ 'selection', 'os' ], Immutable.fromJS(action.data));

      // immediately map to available drive
      newState = storeReducer(newState, {
        type: ACTIONS.SET_AVAILABLE_DRIVES,
        data: state.get('availableDrives').toJS()
      });

      if (selectedDrive) {
        return _.attempt(() => {
          const recommendedImageForSelectedDrive = getRecommendedImage(selectedDrive.toJS(), action.data);

          if (!recommendedImageForSelectedDrive) {
            return storeReducer(newState, {
              type: ACTIONS.REMOVE_DRIVE
            });
          }

          return storeReducer(newState, {
            type: ACTIONS.SELECT_DRIVE,
            data: selectedDrive.get('device')
          });

        });
      }

      return newState;
    }

    case ACTIONS.SET_AVAILABLE_DRIVES: {
      if (!action.data) {
        throw new Error('Missing drives');
      }

      if (!_.isArray(action.data) || !_.every(action.data, _.isPlainObject)) {
        throw new Error(`Invalid drives: ${action.data}`);
      }

      const os = state.getIn([ 'selection', 'os' ], Immutable.fromJS({})).toJS();
      const image = state.getIn([ 'selection', 'image' ], Immutable.fromJS({})).toJS();
      if (os) {
        _.forEach(action.data, (drive) => {
          const recommended = getRecommendedImage(drive, os);
          if (recommended) {
            drive.recommendedImage = recommended;
          }
        });
      }

      const newState = state.set('availableDrives', Immutable.fromJS(action.data));

      if (action.data.length === 1) {
        const drive = _.first(action.data);

        if (_.every([
          constraints.isDriveValid(drive, image, !_.isEmpty(os)),
          constraints.isDriveSizeRecommended(drive, image),
          !constraints.isSystemDrive(drive)
        ])) {

          return storeReducer(newState, {
            type: ACTIONS.SELECT_DRIVE,
            data: drive.device
          });
        }
      }

      const selectedDevice = newState.getIn([ 'selection', 'drive' ]);

      if (selectedDevice && !_.find(action.data, {
        device: selectedDevice
      })) {
        return storeReducer(newState, {
          type: ACTIONS.REMOVE_DRIVE
        });
      }

      return newState;
    }

    case ACTIONS.SET_FLASH_STATE: {
      if (!state.get('isFlashing')) {
        throw new Error('Can\'t set the flashing state when not flashing');
      }

      if (!action.data.type) {
        throw new Error('Missing state type');
      }

      if (!_.isString(action.data.type)) {
        throw new Error(`Invalid state type: ${action.data.type}`);
      }

      if (_.isUndefined(action.data.percentage) || _.isNull(action.data.percentage)) {
        throw new Error('Missing state percentage');
      }

      if (!_.isNumber(action.data.percentage)) {
        throw new Error(`Invalid state percentage: ${action.data.percentage}`);
      }

      if (!action.data.eta && action.data.eta !== 0) {
        throw new Error('Missing state eta');
      }

      if (!_.isNumber(action.data.eta)) {
        throw new Error(`Invalid state eta: ${action.data.eta}`);
      }

      if (_.isUndefined(action.data.speed) || _.isNull(action.data.speed)) {
        throw new Error('Missing state speed');
      }

      return state.set('flashState', Immutable.fromJS(action.data));
    }

    case ACTIONS.RESET_FLASH_STATE: {
      return state
        .set('flashState', DEFAULT_STATE.get('flashState'))
        .set('flashResults', DEFAULT_STATE.get('flashResults'));
    }

    case ACTIONS.SET_FLASHING_FLAG: {
      return state
        .set('isFlashing', true)
        .set('flashResults', DEFAULT_STATE.get('flashResults'));
    }

    case ACTIONS.UNSET_FLASHING_FLAG: {
      if (!action.data) {
        throw new Error('Missing results');
      }

      _.defaults(action.data, {
        cancelled: false
      });

      if (!_.isBoolean(action.data.cancelled)) {
        throw new Error(`Invalid results cancelled: ${action.data.cancelled}`);
      }

      if (action.data.cancelled && action.data.sourceChecksum) {
        throw new Error('The sourceChecksum value can\'t exist if the flashing was cancelled');
      }

      if (action.data.sourceChecksum && !_.isString(action.data.sourceChecksum)) {
        throw new Error(`Invalid results sourceChecksum: ${action.data.sourceChecksum}`);
      }

      if (action.data.errorCode && !_.isString(action.data.errorCode) && !_.isNumber(action.data.errorCode)) {
        throw new Error(`Invalid results errorCode: ${action.data.errorCode}`);
      }

      return state
        .set('isFlashing', false)
        .set('flashResults', Immutable.fromJS(action.data))
        .set('flashState', DEFAULT_STATE.get('flashState'));
    }

    case ACTIONS.SELECT_DRIVE: {
      if (!action.data) {
        throw new Error('Missing drive');
      }

      if (!_.isString(action.data)) {
        throw new Error(`Invalid drive: ${action.data}`);
      }

      const selectedDrive = state.get('availableDrives').find((drive) => {
        return drive.get('device') === action.data;
      });

      if (!selectedDrive) {
        throw new Error(`The drive is not available: ${action.data}`);
      }

      if (selectedDrive.get('protected')) {
        throw new Error('The drive is write-protected');
      }

      const os = state.getIn([ 'selection', 'os' ], Immutable.fromJS({})).toJS();
      if (_.isEmpty(os)) {
        // assume selected is a local image file
        const image = state.getIn([ 'selection', 'image' ]);
        if (image && !constraints.isDriveLargeEnough(selectedDrive.toJS(), image.toJS())) {
          throw new Error('The drive is not large enough');
        }
      } else {
        // assume selected is an OS
        const image = selectedDrive.toJS().recommendedImage;
        if (image) {
          return _.attempt(() => {
            return storeReducer(state, {
              type: ACTIONS.SELECT_IMAGE,
              data: {
                path: image.url,
                size: image.recommendedDriveSize,
                logo: os.logo,
                version: os.version,
                downloadChecksum: image.checksum,
                downloadChecksumType: image.checksumType || 'md5'
              }
            });

          }).setIn([ 'selection', 'drive' ], Immutable.fromJS(action.data));
        }
      }

      return state.setIn([ 'selection', 'drive' ], Immutable.fromJS(action.data));
    }

    case ACTIONS.SELECT_IMAGE: {
      if (!action.data.path) {
        throw new Error('Missing image path');
      }

      if (!_.isString(action.data.path)) {
        throw new Error(`Invalid image path: ${action.data.path}`);
      }

      if (!action.data.size) {
        throw new Error('Missing image size');
      }

      if (!_.isNumber(action.data.size)) {
        throw new Error(`Invalid image size: ${action.data.size}`);
      }

      if (action.data.url && !_.isString(action.data.url)) {
        throw new Error(`Invalid image url: ${action.data.url}`);
      }

      if (action.data.name && !_.isString(action.data.name)) {
        throw new Error(`Invalid image name: ${action.data.name}`);
      }

      if (action.data.logo && !_.isString(action.data.logo)) {
        throw new Error(`Invalid image logo: ${action.data.logo}`);
      }

      if (action.data.version && !_.isString(action.data.version)) {
        throw new Error(`Invalid image version: ${action.data.version}`);
      }

      if (action.data.downloadChecksum && !_.isString(action.data.downloadChecksum)) {
        throw new Error(`Invalid image download checksum: ${action.data.downloadChecksum}`);
      }

      if (action.data.downloadChecksumType && !_.isString(action.data.downloadChecksumType)) {
        throw new Error(`Invalid image download checksum: ${action.data.downloadChecksumType}`);
      }

      const selectedDevice = state.getIn([ 'selection', 'drive' ]);
      const selectedDrive = state.get('availableDrives').find((drive) => {
        return drive.get('device') === selectedDevice;
      });

      const os = state.getIn([ 'selection', 'os' ]);
      if (!os) {
        return _.attempt(() => {
          if (selectedDrive && !_.every([
            constraints.isDriveValid(selectedDrive.toJS(), action.data),
            constraints.isDriveSizeRecommended(selectedDrive.toJS(), action.data)
          ])) {
            return storeReducer(state, {
              type: ACTIONS.REMOVE_DRIVE
            });
          }

          return state;
        }).setIn([ 'selection', 'image' ], Immutable.fromJS(action.data));
      }
      return state.setIn([ 'selection', 'image' ], Immutable.fromJS(action.data));
    }

    case ACTIONS.REMOVE_OS: {
      return _.attempt(function() {
        const image = state.getIn([ 'selection', 'image' ]);
        if (image) {
          return storeReducer(state, {
            type: ACTIONS.REMOVE_IMAGE
          });
        }

        return state;
      }).deleteIn([ 'selection', 'os' ]);
    }

    case ACTIONS.REMOVE_DRIVE: {
      return _.attempt(() => {
        if (state.getIn([ 'selection', 'os' ])) {
          return storeReducer(state, {
            type: ACTIONS.REMOVE_IMAGE
          });
        }
        return state;
      }).deleteIn([ 'selection', 'drive' ]);
    }

    case ACTIONS.REMOVE_IMAGE: {
      return state.deleteIn([ 'selection', 'image' ]);
    }

    case ACTIONS.SET_SETTING: {
      const key = action.data.key;
      const value = action.data.value;

      if (!key) {
        throw new Error('Missing setting key');
      }

      if (!_.isString(key)) {
        throw new Error(`Invalid setting key: ${key}`);
      }

      if (!DEFAULT_STATE.get('settings').has(key)) {
        throw new Error(`Unsupported setting: ${key}`);
      }

      if (_.isObject(value)) {
        throw new Error(`Invalid setting value: ${value}`);
      }

      return state.setIn([ 'settings', key ], value);
    }

    default: {
      return state;
    }

  }
};

module.exports = _.merge(redux.createStore(
  storeReducer,
  DEFAULT_STATE,
  redux.compose(persistState(PERSISTED_PATH, {

    // The following options are set for the sole
    // purpose of dealing correctly with ImmutableJS
    // collections.
    // See: https://github.com/elgerlambert/redux-localstorage#immutable-data

    slicer: (key) => {
      return (state) => {
        return state.get(key);
      };
    },

    serialize: (collection) => {
      return JSON.stringify(collection.toJS());
    },

    deserialize: (data) => {
      return Immutable.fromJS(JSON.parse(data));
    },

    merge: (state, subset) => {

      // In the first run, there will be no information
      // to deserialize. In this case, we avoid merging,
      // otherwise we will be basically erasing the property
      // we aim the keep serialising the in future.
      if (!subset) {
        return;
      }

      // Blindly setting the state to the deserialised subset
      // means that a user could manually edit `localStorage`
      // and extend the application state settings with
      // unsupported properties, since it can bypass validation.
      //
      // The alternative, which would be dispatching each
      // deserialised settins through the appropriate action
      // is not very elegant, nor performant, so we decide
      // to intentionally ignore this little flaw since
      // adding extra properties makes no damage at all.
      return state.set(PERSISTED_PATH, subset);

    }

  }))
), {
  Actions: ACTIONS,
  Defaults: DEFAULT_STATE
});
