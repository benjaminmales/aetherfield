# nRF EdgeAI Desktop Inference Runner

nRF EdgeAI Desktop Inference Runner is an executable containing a user-specific Nordic EdgeAI Lab solution. With its help, the user can validate the results of the inference of the model even without implementation in the Edge device!

nRF EdgeAI Inference Runner сompiled for the following OS:
 * `nrf_edgeai_inference_runner_linux` - Linux based system, e.g. ubuntu:20.04;
 * `nrf_edgeai_inference_runner_win` - 64-bit Windows based system;
 * `nrf_edgeai_inference_runner_mac` - x86 MacOs based system.

# How to use

nRF EdgeAI Inference Runner has user CLI interface for executing various commands.

To see `help` you can run `nrf_edgeai_inference_runner` without any arguments:
``` C

.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux

DESCRIPTION
        nRF EdgeAI Inference Runner Executable  

SYNOPSIS
        nrf_edgeai_inference_runner_win.exe info
        nrf_edgeai_inference_runner_win.exe inference <dataset> [-t <target>] [-n <session>] [-d
            <delimiter>] [-s <filename>]

        nrf_edgeai_inference_runner_win.exe metrics <dataset> [-t <target>] [-n <session>] [-d
            <delimiter>] [-s <filename>]

OPTIONS
        info                      print EdgeAI Lab solution info

        inference
            <dataset>             filename of the user dataset
            -t, --target          set the dataset target column name ('target' by default)
            -sn, --session         set the dataset session column name ('session' by default)
            -d, --delimiter       set the dataset delimiter [comma|semicolon|tab|caret|vbar]
                                  ('comma' by default)
            -s, --save            save the inference results to the <filename>

        metrics
            <dataset>             filename of the user dataset with target
            -t, --target          set the dataset target column name ('target' by default)
            -sn, --session         set the dataset session column name ('session' by default)            
            -d, --delimiter       set the dataset delimiter [comma|semicolon|tab|caret|vbar]
                                  ('comma' by default)

LICENSE
        Copyright (c) 2021 Nordic Semiconductor ASA.
```

## Get EdgeAI Lab solution information

Use `info` command to see EdgeAI Lab solution information that compiled in Inference Runner:

``` C

.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux info
      Solution name: My_Solution
    Model bit depth: 16 bits
      Float support: 1
          Task type: Binary classification
         Input type: float
Unique inputs count: 10
        Window size: 1
 Input scaling type: unified
      Outputs count: 2
      Neurons count: 11
  Model flash usage: 241 bytes

```

## Run inference

Use `inference` command to run inference on the provided CSV dataset.

Supported two kinds of datasets: `CSV` text file format and `EdgeAI Lab dataset` binary file format (with corresponding filename extensions '.csv' and '.bin'). 
The `CSV` dataset should have a header and contains only number fields separated by comma.

Inference result will be printed to the screen. Additional params `-s <filename>` (or `--save <fileneme>`) stores the inference results to the CSV file.

usage examples:
```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux inference test.csv
```
```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux inference test.csv -s result.csv
```

## Get metrics

Use `metrics` command to calculate validation metrics. It is only possible if the provided dataset contains target values. Dataset shoud have a header with a target column named `target`.

usage examples:
```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux metrics test.csv
```

## Managing CSV file reading settings

When a CSV file is used as a dataset, you can specify the delimiter character, the name of the target column and the name of the session column if they differ from the default values `,` and `target`, `session` respectively. This can be done by specifying additional parameters when calling `inference` and `metrics` command.

Use `-d <delimiter>` or `--delimiter <delimiter>` to specify delimiter character by keywords:
- comma - `,`
- semicolon - `;`
- tab - `\t`
- caret - `^`
- vbar - `|`

```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux inference test.csv -d tab
```

Use `-t <target name>` or `--target <target name>` to specify the target column name of the provided dataset.

```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux inference test.csv -t label
```

Use `-sn <session name>` or `--session <session name>` to specify the session column name of the provided dataset.

```
.\artifacts\inference_runner>nrf_edgeai_inference_runner_linux inference test.csv -sn testee
```
