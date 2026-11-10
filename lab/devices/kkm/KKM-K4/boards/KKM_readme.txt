1. The accleration sensor of K4/K4 is lis2dw, please download the driver from https://www.st.com/en/mems-and-sensors/lis2dw12.html
2. please setting follow 32k crystal parameters in overlay file:
    &lfxo{
        load-capacitors = "internal";
        load-capacitance-femtofarad=<14000>;
    };
    
3. accleration demo: 54L15Demo.zip, base on ncs 3.2.4