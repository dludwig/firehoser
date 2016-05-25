'use strict';

var _ = require('lodash');
var AWS = require('aws-sdk');
var async = require('async');
var JaySchema = require('jayschema');
var moment = require('moment');

var schemaValidator = new JaySchema();

class DeliveryStream{
    constructor(name, awsConfig=null, schema=null, retryInterval=1500, firehose=null, logger=null){
        this.maxIngestion = 400;
        this.maxDrains = 3;
        this.name = name;
        if (awsConfig !== null){
            AWS.config.update(awsConfig);
        }
        this.schema = schema;
        this.retryInterval = retryInterval;
        this.firehose = firehose ? firehose : new AWS.Firehose({params: {DeliveryStreamName: name}});
        this.log = logger ? logger : () => {};
    }

    validateRecord(record){
        return schemaValidator.validate(record, this.schema);
    }

    formatRecord(record){
        return {Data: record + '\n'};
    }

    putRecord(record){
        return this.putRecords([record]);
    }

    putRecords(records){
        this.log(`putRecords() called with ${records.length} records.`);
        return new Promise((resolve, reject) => {
            // Validate records against a schema, if necessary.
            var schemaError, schemaErrorRecord;
            if (this.schema){
                _.forEach(records, (record) => {
                    let validationErrors = this.validateRecord(record);
                    if (!_.isEmpty(validationErrors)){
                        schemaError = validationErrors[0];
                        schemaErrorRecord = record;
                        return false;
                    }
                });            
                if (schemaError){
                    this.log(`Encountered schema errors: ${schemaError.desc}`);
                    return reject(new Error({
                        type: "schema",
                        details: schemaError,
                        trigger: schemaErrorRecord
                    }));
                }
            }

            // Split the records into reasonably-sized chunks.
            records = _.map(records, this.formatRecord);
            let chunks = _.chunk(records, this.maxIngestion);
            let tasks = [];
            for (let i=0; i < chunks.length; i++){
                tasks.push(this.drain.bind(this, chunks[i]));
            }

            // Schedule the chunks all at the same time.
            this.log(`Kicking off ${tasks.length} calls to drain() for ${records.length} records.`);
            async.parallelLimit(tasks, this.maxDrains, function(err, results){
                if (err){
                    this.log(`Encountered firehose error: ${err}`);
                    return reject(new Error({type: "firehose", details: err, trigger: null}));
                }
                return resolve(results);
            });
        });
    }

    drain(records, cb, numRetries=0){
        var leftovers = [];
        this.log(`Draining ${records.length} records.  Pass #${numRetries + 1}`);
        this.firehose.putRecordBatch({Records: records}, function(firehoseErr, resp){
            // Stuff broke!
            if (firehoseErr){
                return cb(firehoseErr);
            }

            // Not all records make it in, but firehose keeps on chugging!
            if (resp.FailedPutCount > 0){
            }

            // Push errored records back into the next list.
            for (let [orig, result] of _.zip(records, resp.RequestResponses)){
                if (!_.isUndefined(result.ErrorCode)){
                    this.log(`Got ErrorCode ${result.ErrorCode} for record ${orig}`);
                    leftovers.push(orig);
                }
            }

            // Recurse!
            if (leftovers.length){
                return setTimeout(function(){
                    this.drain(leftovers, cb, numRetries + 1);
                }, this.retryInterval);
            } else {
                return cb(null); 
            }
        });
    }
}

class JSONDeliveryStream extends DeliveryStream {
    formatRecord(record){
        return super.formatRecord(JSON.stringify(record));
    }
}

class QueuableDeliveryStream extends DeliveryStream {
    constructor(name, maxTime=30000, maxSize=500, ...args){
        super(name, ...args);
        this.queue = [];
        this.timeout = null;
        this.maxTime = maxTime;
        this.maxSize = maxSize;
    }

    putRecords(records){
        this.log(`putRecords() called with ${records.length} records.`);
        this.queue.push(...records);
        this.log(`queue size is: ${this.queue.length}, maxSize is: ${this.maxSize}.`);
        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxSize){
                // Queue's full!
                this.log(`queue is full, draining immediately.`);
                if (this.timeout !== null){
                    clearTimeout(this.timeout);
                    this.timeout = null;
                }
                let toQueue = this.queue.splice(0, this.queue.length);
                return super.putRecords(
                    toQueue
                ).then((results) => {
                    resolve(results);
                }).catch((err) => {
                    reject(err);
                });
            }
            if (this.queue.length && this.timeout === null){
                // Start the countdown timer since we've not already done so.
                this.log(`Starting a countdown timer for ${this.maxTime} milliseconds from now.`);
                this.timeout = setTimeout(() => {
                    this.log(`Countdown timer expired, time to drain the queue of ${this.queue.length} records.`);
                    let toQueue = this.queue.splice(0, this.queue.length);
                    super.putRecords(
                        toQueue
                    ).then((results) => {
                        resolve(results);
                    }).catch((err) => {
                        reject(err);
                    });
                }, this.maxTime);
            }
        });
    }
}

class QueuableJSONDeliveryStream extends QueuableDeliveryStream {
    formatRecord(record){
        return super.formatRecord(JSON.stringify(record));
    }
}

function makeRedshiftTimestamp(input){
    return moment(input).utc().format('YYYY-MM-DD HH:mm:ss')
}

module.exports = {
    DeliveryStream: DeliveryStream,
    JSONDeliveryStream: JSONDeliveryStream,
    QueuableDeliveryStream: QueuableDeliveryStream,
    QueuableJSONDeliveryStream: QueuableJSONDeliveryStream,
    makeRedshiftTimestamp: makeRedshiftTimestamp
};
