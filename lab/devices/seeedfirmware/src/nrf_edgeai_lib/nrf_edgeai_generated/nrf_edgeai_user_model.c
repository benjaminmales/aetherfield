/* 2026-01-23T13:25:07.837821 */
/*
* Copyright (c) 2021 Nordic Semiconductor ASA
* SPDX-License-Identifier: Apache-2.0
*/
#include "nrf_edgeai_user_model.h"
#include "nrf_edgeai_user_types.h"
#include <nrf_edgeai/nrf_edgeai_platform.h>
#include <nrf_edgeai/rt/private/nrf_edgeai_interfaces.h>

//////////////////////////////////////////////////////////////////////////////
/* Nordic EdgeAI Lab Solution ID and Runtime Version */
#define EDGEAI_LAB_SOLUTION_ID_STR      "91280"
#define EDGEAI_RUNTIME_VERSION_COMBINED 0x00000001

//////////////////////////////////////////////////////////////////////////////
#define INPUT_TYPE                         i16

/** User input features type */
#define INPUT_FEATURE_DATA_TYPE            NRF_EDGEAI_INPUT_I16

/** Number of unique features in the original input sample */
#define INPUT_UNIQ_FEATURES_NUM            6

/** Number of unique features actually used by NN from the original input sample */
#define INPUT_UNIQ_FEATURES_USED_NUM       6

/** Number of input feature samples that should be collected in the input window
 *  feature_sample = 1 * INPUT_UNIQ_FEATURES_NUM
 */
#define INPUT_WINDOW_SIZE                  93

/** Number of input feature samples on that the input window is shifted */
#define INPUT_WINDOW_SHIFT                 93

/** Number of subwindows in input feature window,
* the SUBWINDOW_SIZE = INPUT_WINDOW_SIZE / INPUT_SUBWINDOW_NUM
* if the window size is not divisible by the number of subwindows without a remainder,
* the remainder is added to the last subwindow size */
#define INPUT_SUBWINDOW_NUM                 0

#define INPUT_UNIQUE_SCALES_NUM (sizeof(INPUT_FEATURES_SCALE_MIN) / sizeof(INPUT_FEATURES_SCALE_MIN[0])) 

//////////////////////////////////////////////////////////////////////////////
#define MODEL_NEURONS_NUM          6
#define MODEL_WEIGHTS_NUM          37
#define MODEL_OUTPUTS_NUM          3
#define MODEL_TASK                 0
#define MODEL_PARAMS_TYPE          q16
#define MODEL_REORDERING           1

#define MODEL_USES_AS_INPUT_INPUT_FEATURES 0
#define MODEL_USES_AS_INPUT_DSP_FEATURES 1
#define MODEL_USES_AS_INPUT_MASK ((MODEL_USES_AS_INPUT_INPUT_FEATURES << 0) | (MODEL_USES_AS_INPUT_DSP_FEATURES << 1)) 

//////////////////////////////////////////////////////////////////////////////
/** Defines input(also used for LAG) features MIN scaling factor
 */
static const nrf_user_input_t INPUT_FEATURES_SCALE_MIN[] = {
 -32738, -32721, -32755, -6121, -9693, -8026 };

/** Defines input(also used for LAG) features MAX scaling factor
 */
static const nrf_user_input_t INPUT_FEATURES_SCALE_MAX[] = {
 32764, 32567, 32681, 5360, 7251, 5734 };

/** Defines which unique features from the input data will be used/collected,
 *  one bit for one unique feature, starting from LSB
 */
#define INPUT_FEATURES_USAGE_MASK NULL

/** Defines which unique input features is used for LAG features processing,
 *  one bit for one unique feature, starting from LSB
 */
#define INPUT_FEATURES_USED_FOR_LAGS_MASK NULL

//////////////////////////////////////////////////////////////////////////////
/** Input feature buffer element size, 
 * if quantization of model is bigger than input features size in bits, 
 * the size of input buffer should aligned to nrf_user_neuron_t */ 
#define INPUT_TYPE_SIZE \
    ((sizeof(nrf_user_input_t) > sizeof(nrf_user_neuron_t)) ? sizeof(nrf_user_input_t) : sizeof(nrf_user_neuron_t)) 

/** Input features window size in bytes to allocate statically */ 
#define INPUT_WINDOW_BUFFER_SIZE_BYTES \
    (INPUT_WINDOW_SIZE * INPUT_UNIQ_FEATURES_NUM * INPUT_TYPE_SIZE) 

static uint8_t input_window_[INPUT_WINDOW_BUFFER_SIZE_BYTES] __NRF_EDGEAI_ALIGNED; 

#define INPUT_WINDOW_MEMORY    &input_window_[0] 

static nrf_edgeai_window_ctx_t input_window_ctx_; 
#define P_INPUT_WINDOW_CTX     &input_window_ctx_ 

//////////////////////////////////////////////////////////////////////////////
/** The maximum number of extracted features that user used for all unique input features */
#define EXTRACTED_FEATURES_NUM  25

#define EXTRACTED_FEATURES_META_TYPE i32 

/** DSP feature buffer element size,
 * if quantization of model is bigger than DSP features size in bits,
 * the size of extracted DSP features buffer should aligned to nrf_user_neuron_t */
#define EXTRACTED_FEATURE_SIZE_BYTES                                                  \
    ((sizeof(nrf_user_feature_t) > sizeof(nrf_user_neuron_t)) ? sizeof(nrf_user_feature_t) : \
                                                            sizeof(nrf_user_neuron_t))

/** Size of extracted features buffer in bytes */
#define EXTRACTED_FEATURES_BUFFER_SIZE_BYTES (EXTRACTED_FEATURES_NUM * EXTRACTED_FEATURE_SIZE_BYTES) 

/** Defines feature extraction masks used as nrf_edgeai_features_mask_t,
 *  64 bit for one unique input feature, @ref nrf_edgeai_features_mask_t to see bitmask
 */

static const uint64_t FEATURES_EXTRACTION_MASK[] = {
 0x410d00000000, 0x30b00000000, 0x10f00000000, 0x50c00000000,
 0x858200000000, 0x400000000000 };

/** Defines arguments used while feature extraction
 */

/** Defines arguments used while feature extraction
 */
#define FEATURES_EXTRACTION_ARGUMENTS NULL

/** Defines extracted features MIN scaling factor
 */
static const nrf_user_feature_t EXTRACTED_FEATURES_SCALE_MIN[] = {
 -32738, 69, -6932, 207, 205, -32721, -9358, -10172, 348, 10, -32755,
 -8397, 74, -11118, 348, 19, -1835, 11, 0, -533, 6, 7, 0, 4, 11 };

/** Defines extracted features MAX scaling factor
 */
static const nrf_user_feature_t EXTRACTED_FEATURES_SCALE_MAX[] = {
 9340, 64872, 9512, 10159, 9512, 8147, 32567, 8924, 10296, 576, 9917,
 32681, 65230, 9954, 13621, 9925, 1567, 2677, 217, 7251, 4400, 4400, 467,
 606, 3055 };

/** Memory allocation to store extracted features during DSP pipeline */
static uint8_t extracted_features_buffer_[EXTRACTED_FEATURES_BUFFER_SIZE_BYTES] __NRF_EDGEAI_ALIGNED;


/** Timedomain features processing context  */
#define P_TIMEDOMAIN_FEATURES_CTX  NULL
/** Timedomain features in feature extraction pipeline  */
static const nrf_edgeai_features_pipeline_func_i16_t timedomain_features_[] = {
    nrf_edgeai_feature_utility_tss_sum_i16,
    nrf_edgeai_feature_min_max_range_i16,
    nrf_edgeai_feature_mean_i16,
    nrf_edgeai_feature_std_i16,
    nrf_edgeai_feature_rms_i16,
    nrf_edgeai_feature_mcr_i16,
    nrf_edgeai_feature_zcr_i16,
    nrf_edgeai_feature_absmean_i16,
    nrf_edgeai_feature_amdf_i16
 };

static const nrf_edgeai_features_pipeline_ctx_t timedomain_pipeline_ = {
    .functions_num     = sizeof(timedomain_features_) / sizeof(timedomain_features_[0]),
    .functions.p_void  = timedomain_features_,
    .p_ctx             = P_TIMEDOMAIN_FEATURES_CTX,
};
#define P_TIMEDOMAIN_PIPELINE &timedomain_pipeline_ 

#define P_FREQDOMAIN_PIPELINE NULL

static nrf_edgeai_dsp_pipeline_t dsp_pipeline_ = { 
   .features = {  
       .p_masks = (const nrf_edgeai_features_mask_t*)FEATURES_EXTRACTION_MASK, 
       .extracted_memory.p_void = extracted_features_buffer_, 
       .overall_num = EXTRACTED_FEATURES_NUM, 
       .masks_num = sizeof(FEATURES_EXTRACTION_MASK) / sizeof(FEATURES_EXTRACTION_MASK[0]), 

       .p_timedomain_pipeline = P_TIMEDOMAIN_PIPELINE, 
       .p_freqdomain_pipeline = P_FREQDOMAIN_PIPELINE, 

       .meta.EXTRACTED_FEATURES_META_TYPE = { 
           .p_min = EXTRACTED_FEATURES_SCALE_MIN, 
           .p_max = EXTRACTED_FEATURES_SCALE_MAX, 
       .p_arguments = FEATURES_EXTRACTION_ARGUMENTS, 
       },
   }, 
}; 

#define P_DSP_PIPELINE         &dsp_pipeline_ 


//////////////////////////////////////////////////////////////////////////////
static const nrf_user_weight_t MODEL_WEIGHTS[] = {
 32764, 32764, 32764, -32256, -17625, 22007, -32768, 13360, -13823, 4801,
 5803, -3738, -32463, 5950, 22564, 28058, -16839, -11361, 26046, 4719,
 8628, 12077, 2124, 16383, -10741, 32620, 32766, 3691, -26692, 6525, -3094,
 19690, -31116, -16383, -27290, 32765, -6590 };

static const uint16_t MODEL_NEURONS_LINKS[] = {
 2, 3, 4, 9, 10, 25, 0, 25, 1, 5, 8, 11, 22, 24, 25, 2, 25, 0, 3, 4, 6, 7,
 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 25, 4, 25 };

static const uint16_t MODEL_NEURON_INTERNAL_LINKS_NUM[] = {
 0, 7, 8, 16, 17, 36 };

static const uint16_t MODEL_NEURON_EXTERNAL_LINKS_NUM[] = {
 6, 8, 15, 17, 35, 37 };

static const nrf_user_coeff_t MODEL_NEURON_ACTIVATION_WEIGHTS[] = {
 0, 40958, 0, 40685, 0, 40959 };

static const uint8_t MODEL_NEURON_ACTIVATION_TYPE_MASK[] = {
 0x15 };

static const uint16_t MODEL_OUTPUT_NEURONS_INDICES[] = {
 1, 3, 5 };


#define NN_DECODED_OUTPUT_INIT                 \
.classif = {                                   \
   .predicted_class = 0,                       \
   .num_classes = MODEL_OUTPUTS_NUM,           \
}

//////////////////////////////////////////////////////////////////////////////
#define NN_INPUT_SETUP_INTERFACE       nrf_edgeai_input_setup_discrete_window 
#define NN_INPUT_FEED_INTERFACE        nrf_edgeai_input_feed_discrete_window_i16 
#define NN_PROCESS_FEATURES_INTERFACE  nrf_edgeai_process_features_dsp_i16_q16 
#define NN_RUN_INFERENCE_INTERFACE     nrf_edgeai_run_model_inference_q16 
#define NN_PROPAGATE_OUTPUTS_INTERFACE nrf_edgeai_output_propagate_q16 
#define NN_DECODE_OUTPUTS_INTERFACE    nrf_edgeai_output_decode_classification_q16 

//////////////////////////////////////////////////////////////////////////////

static nrf_user_neuron_t model_neurons_[MODEL_NEURONS_NUM];
static nrf_user_output_t model_outputs_[MODEL_OUTPUTS_NUM];

//////////////////////////////////////////////////////////////////////////////

static nrf_edgeai_t nrf_edgeai_ = {
    ///
    .metadata.p_solution_id     = EDGEAI_LAB_SOLUTION_ID_STR,
    .metadata.version.combined  = EDGEAI_RUNTIME_VERSION_COMBINED,
    ///   
    .input.p_used_for_lags_mask = INPUT_FEATURES_USED_FOR_LAGS_MASK,
    .input.p_usage_mask         = INPUT_FEATURES_USAGE_MASK,
    .input.type                 = INPUT_FEATURE_DATA_TYPE,
    .input.unique_num           = INPUT_UNIQ_FEATURES_NUM,
    .input.unique_num_used      = INPUT_UNIQ_FEATURES_USED_NUM,
    .input.unique_scales_num    = INPUT_UNIQUE_SCALES_NUM,
    .input.window_size          = INPUT_WINDOW_SIZE,
    .input.window_shift         = INPUT_WINDOW_SHIFT,
    .input.subwindow_num        = INPUT_SUBWINDOW_NUM,
    .input.window_memory.p_void = INPUT_WINDOW_MEMORY,
    .input.p_window_ctx         = P_INPUT_WINDOW_CTX,

    .input.scale.INPUT_TYPE = {
        .p_min = INPUT_FEATURES_SCALE_MIN,
        .p_max = INPUT_FEATURES_SCALE_MAX,
    }, 
    ///
    .p_dsp = P_DSP_PIPELINE,
    ///
    .model.meta.p_neuron_internal_links_num = MODEL_NEURON_INTERNAL_LINKS_NUM,
    .model.meta.p_neuron_external_links_num = MODEL_NEURON_EXTERNAL_LINKS_NUM,
    .model.meta.p_output_neurons_indices    = MODEL_OUTPUT_NEURONS_INDICES,
    .model.meta.p_neuron_links              = MODEL_NEURONS_LINKS,
    .model.meta.p_neuron_act_type_mask      = MODEL_NEURON_ACTIVATION_TYPE_MASK,
    .model.meta.outputs_num                 = MODEL_OUTPUTS_NUM,
    .model.meta.neurons_num                 = MODEL_NEURONS_NUM,
    .model.meta.weights_num                 = MODEL_WEIGHTS_NUM,
    .model.meta.task                        = (nrf_edgeai_model_task_t)MODEL_TASK,
    .model.meta.uses_as_input.all           = MODEL_USES_AS_INPUT_MASK,

    .model.params.MODEL_PARAMS_TYPE = {
        .p_weights      = MODEL_WEIGHTS,
        .p_act_weights = MODEL_NEURON_ACTIVATION_WEIGHTS,
        .p_neurons      = model_neurons_,
    },

    .model.output.memory.p_void = model_outputs_,
    .model.output.num = MODEL_OUTPUTS_NUM,
    ///
    .interfaces.input_setup = NN_INPUT_SETUP_INTERFACE,
    .interfaces.feed_inputs = NN_INPUT_FEED_INTERFACE,
    .interfaces.process_features = NN_PROCESS_FEATURES_INTERFACE,
    .interfaces.run_inference = NN_RUN_INFERENCE_INTERFACE,
    .interfaces.propagate_outputs = NN_PROPAGATE_OUTPUTS_INTERFACE,
    .interfaces.decode_outputs = NN_DECODE_OUTPUTS_INTERFACE,
    ///
    .decoded_output = { NN_DECODED_OUTPUT_INIT },
};

//////////////////////////////////////////////////////////////////////////////

nrf_edgeai_t* nrf_edgeai_user_model(void)
{
    return &nrf_edgeai_;
}

//////////////////////////////////////////////////////////////////////////////

uint32_t nrf_edgeai_user_model_size(void)
{
    uint32_t model_meta_size = 
    (sizeof(MODEL_WEIGHTS) + sizeof(MODEL_NEURONS_LINKS) + sizeof(MODEL_NEURON_EXTERNAL_LINKS_NUM) +
            sizeof(MODEL_NEURON_INTERNAL_LINKS_NUM) + sizeof(MODEL_NEURON_ACTIVATION_WEIGHTS) +
            sizeof(MODEL_NEURON_ACTIVATION_TYPE_MASK) +
            sizeof(MODEL_OUTPUT_NEURONS_INDICES));

#if MODEL_TASK == __NRF_EDGEAI_TASK_ANOMALY_DETECTION
    model_meta_size += sizeof(MODEL_AVERAGE_EMBEDDING) + sizeof(MODEL_OUTPUT_SCALE_MIN) + 
                        sizeof(MODEL_OUTPUT_SCALE_MAX);
#endif

#if MODEL_TASK == __NRF_EDGEAI_TASK_REGRESSION
    model_meta_size += sizeof(MODEL_OUTPUT_SCALE_MIN) + sizeof(MODEL_OUTPUT_SCALE_MAX);
#endif
 
    return model_meta_size;
}


